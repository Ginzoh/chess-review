/**
 * Game analysis: drives the engine over every position, scores each move and
 * classifies it. Everything downstream (the review text, the graph, the move
 * list) reads the object produced by `analyseGame`.
 */

import { Chess, nonPawnMaterial, captureGain, seeAt, uciToMove, pvToSan } from './chessutils.js';

/* ------------------------------------------------------------- scoring -- */

/** Cap mate scores so they behave in arithmetic without swamping everything. */
export function scoreToCp(score) {
  if (score.mate !== null && score.mate !== undefined) {
    const sign = score.mate >= 0 ? 1 : -1;
    return sign * (10000 - Math.min(Math.abs(score.mate), 100) * 10);
  }
  return score.cp || 0;
}

/**
 * Expected score (0-100) for the side to move. Lichess' logistic fit - it is what
 * makes "-400 to -700" count for far less than "0 to -300", which is how humans
 * actually experience mistakes.
 */
export function cpToWinPercent(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

export function winPercentFromScore(score) {
  if (score.mate !== null && score.mate !== undefined) return score.mate > 0 ? 100 : 0;
  return cpToWinPercent(score.cp || 0);
}

/** Per-move accuracy from how much expected score the move gave away. */
export function accuracyFromWinLoss(winLoss) {
  const acc = 103.1668 * Math.exp(-0.04354 * Math.max(0, winLoss)) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

/**
 * Put our accuracy on Chess.com's scale.
 *
 * Fitted against Chess.com's own figure on 34 real games / 68 player-sides, ratings
 * 100-3181 (scripts/accuracy-lab.mjs). With the per-move floor and plain-mean
 * aggregation above, the correlation is r = 0.963 and the residual after this map
 * is 6.2 points; 66 of 68 sides land within 10. The slope is well above 1 because a
 * mean of per-move scores, most of which are 100, is a compressed scale - the map
 * stretches it onto the one users compare against. Steeper per-move curves were
 * tried to bring the slope down and fitted worse, so the stretch stays.
 */
export const ACCURACY_CALIBRATION = { slope: 1.936, intercept: -92.78 };

export function calibrateAccuracy(raw) {
  if (raw === null || raw === undefined || !isFinite(raw)) return raw;
  const mapped = ACCURACY_CALIBRATION.slope * raw + ACCURACY_CALIBRATION.intercept;
  return Math.max(0, Math.min(100, mapped));
}

/**
 * Game accuracy is the plain mean of the per-move accuracies.
 *
 * It used to be a blend of a volatility-weighted mean and a harmonic mean, after
 * Lichess. Tested against Chess.com's published accuracy on 68 player-sides
 * (scripts/accuracy-lab.mjs), the plain mean tracks it far better: r = 0.96 versus
 * 0.87, and 66 of 68 sides land within 10 points once the scale is mapped, versus
 * 46 of 68. The harmonic component was the problem - a couple of low-scored moves
 * dominated it in ways Chess.com's number does not reflect.
 */
export function aggregateAccuracy(moveAccuracies) {
  if (!moveAccuracies.length) return null;
  const mean = moveAccuracies.reduce((a, b) => a + b, 0) / moveAccuracies.length;
  return Math.max(0, Math.min(100, mean));
}

/**
 * The expected-score loss a move is charged, before it becomes an accuracy.
 *
 * Win-probability loss alone goes flat once a game is decided: from -5 to -10 costs
 * almost nothing, so a player being crushed collected 100s for every move and came
 * out at 86% in a game Chess.com scored 53%. A floor from material loss fixes that -
 * each pawn given away costs at least four points, with evaluations clamped at +/-15
 * first so a mate score is not counted as ninety-nine pawns. Allowing a forced mate
 * where none existed, or letting one slip, carries its own floor. Chosen by fit
 * against Chess.com's numbers; see scripts/accuracy-lab.mjs.
 */
const FLOOR_PER_PAWN = 4;
const FLOOR_ALLOWED_MATE = 25;
const FLOOR_MISSED_MATE = 25;
const FLOOR_MISSED_MATERIAL = 23;
const LOSS_CAP = 60;

/**
 * A move made while already inside a forced mate cannot score above this. When
 * every move loses, "best" only means slowest, and Chess.com's figure reflects that:
 * on 30 checkmate games, sides that made three or more such moves read 7.4 points
 * too kind without the cap and 1.0 too harsh with it (scripts/accuracy-lab.mjs).
 * The label is untouched - the move is still the best available - only the score.
 */
const MATED_ACCURACY_CAP = 80;

export function effectiveLoss(ctx) {
  if (ctx.isBest && !ctx.missedWin) return 0;
  let loss = Math.max(0, ctx.winLoss);
  if (ctx.missedWin) {
    loss = Math.max(loss, ctx.missedWin.kind === 'mate' ? FLOOR_MISSED_MATE : FLOOR_MISSED_MATERIAL);
  } else {
    const clamp = (v) => Math.max(-1500, Math.min(1500, v));
    const cpLoss = Math.max(0, clamp(ctx.evalBeforeCp) - clamp(ctx.evalAfterCp));
    loss = Math.max(loss, (cpLoss / 100) * FLOOR_PER_PAWN);
    if (ctx.allowedMate) loss = Math.max(loss, FLOOR_ALLOWED_MATE);
  }
  return Math.min(loss, LOSS_CAP);
}

/* ------------------------------------------------------ classification -- */

export const LABELS = {
  brilliant: { key: 'brilliant', text: 'Brilliant', symbol: '!!', rank: 0 },
  great: { key: 'great', text: 'Great move', symbol: '!', rank: 1 },
  best: { key: 'best', text: 'Best move', symbol: '★', rank: 2 },
  excellent: { key: 'excellent', text: 'Excellent', symbol: '✓', rank: 3 },
  good: { key: 'good', text: 'Good', symbol: '✓', rank: 4 },
  // Had a forced win and let it go while staying on top. The win-probability curve
  // is flat up there, so without its own label this would pass as "Excellent".
  missedWin: { key: 'missedWin', text: 'Missed win', symbol: '✕', rank: 4.5 },
  inaccuracy: { key: 'inaccuracy', text: 'Inaccuracy', symbol: '?!', rank: 5 },
  mistake: { key: 'mistake', text: 'Mistake', symbol: '?', rank: 6 },
  blunder: { key: 'blunder', text: 'Blunder', symbol: '??', rank: 7 },
  forced: { key: 'forced', text: 'Forced', symbol: '□', rank: 8 }
};

function classify(ctx) {
  const { winLoss, isBest, legalCount, gapToSecond, evalBeforeCp, sacrifice, evalAfterCp, isRecapture, missedWin } = ctx;

  if (legalCount === 1) return LABELS.forced;

  if (isBest) {
    // Taking back on the square the opponent just captured is the move anyone
    // would find; it should never be dressed up as a discovery.
    const stillFine = evalAfterCp > -100;
    const notAlreadyWinning = evalBeforeCp < 700;
    if (!isRecapture && sacrifice >= 1.5 && stillFine && notAlreadyWinning) return LABELS.brilliant;
    // The only move that holds the position together.
    if (!isRecapture && gapToSecond !== null && gapToSecond >= 15 && notAlreadyWinning) return LABELS.great;
    return LABELS.best;
  }

  // A win thrown away while still clearly winning is its own category - the game
  // is not in doubt, the kill was just not delivered. Once the advantage is gone
  // too, the mistake/blunder label below says more.
  if (missedWin && evalAfterCp >= 200) return LABELS.missedWin;

  if (winLoss < 2) return LABELS.excellent;
  if (winLoss < 5) return LABELS.good;
  if (winLoss < 10) return LABELS.inaccuracy;
  if (winLoss < 20) return LABELS.mistake;
  return LABELS.blunder;
}

/* ------------------------------------------------------------- phases -- */

function phaseOf(fen, ply) {
  const material = nonPawnMaterial(fen);
  if (material <= 13) return 'endgame';
  if (ply < 20) return 'opening';
  return 'middlegame';
}

/* -------------------------------------------------------------- clocks -- */

function parseClock(comment) {
  if (!comment) return null;
  const m = comment.match(/\[%clk\s+(\d+):(\d+):([\d.]+)\]/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

function parseIncrement(timeControl) {
  if (!timeControl) return 0;
  const m = String(timeControl).match(/\+(\d+)/);
  return m ? Number(m[1]) : 0;
}

/* ------------------------------------------------------------- runner -- */

/**
 * Analyse a full game.
 *
 * @param {Engine} engine   booted engine
 * @param {string} pgn      raw PGN
 * @param {{depth:number}} opts
 * @param {(done:number,total:number)=>void} onProgress
 */
export async function analyseGame(engine, pgn, opts, onProgress) {
  const depth = (opts && opts.depth) || 14;
  const chess = new Chess();
  chess.loadPgn(pgn);

  const headers = chess.getHeaders();
  const history = chess.history({ verbose: true });
  if (!history.length) throw new Error('This game has no moves to review.');

  const comments = new Map();
  for (const c of chess.getComments()) comments.set(c.fen, c.comment);

  const increment = parseIncrement(headers.TimeControl);

  // One engine call per position, plus the final one: N+1 searches for N moves.
  const positions = history.map((m) => m.before).concat([history[history.length - 1].after]);
  const evals = [];

  await engine.newGame();
  for (let i = 0; i < positions.length; i++) {
    const result = await engine.analyse(positions[i], { depth: depth, multipv: 2 });
    evals.push(result);
    if (onProgress) onProgress(i + 1, positions.length + 1);
  }

  await huntForMates(engine, positions, evals, depth, onProgress);

  const moves = [];
  const clockBySide = { w: null, b: null };

  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    const mover = move.color;
    const before = evals[i];
    const after = evals[i + 1];

    const board = new Chess(move.before);
    const legalCount = board.moves().length;

    // Scores are reported from the side to move; normalise everything to the mover.
    const bestLine = before.lines[0] || null;
    const secondLine = before.lines[1] || null;
    const afterLine = after.lines[0] || null;

    const evalBeforeCp = bestLine ? scoreToCp(bestLine) : 0;
    const winBefore = bestLine ? winPercentFromScore(bestLine) : 50;

    let evalAfterCp;
    let winAfter;
    const boardAfter = new Chess(move.after);
    if (boardAfter.isCheckmate()) {
      evalAfterCp = 10000; // the mover just delivered mate
      winAfter = 100;
    } else if (boardAfter.isDraw() || boardAfter.isStalemate()) {
      evalAfterCp = 0;
      winAfter = 50;
    } else if (afterLine) {
      evalAfterCp = -scoreToCp(afterLine);
      winAfter = 100 - winPercentFromScore(afterLine);
    } else {
      evalAfterCp = evalBeforeCp;
      winAfter = winBefore;
    }

    const bestUci = bestLine && bestLine.pv.length ? bestLine.pv[0] : null;
    const playedUci = move.from + move.to + (move.promotion || '');
    const isBest = !!bestUci && bestUci === playedUci;

    const winLoss = isBest ? 0 : Math.max(0, winBefore - winAfter);

    const gapToSecond = secondLine ? winPercentFromScore(bestLine) - winPercentFromScore(secondLine) : null;

    // Did the move give away material that the engine nonetheless endorses?
    let sacrifice = 0;
    if (move.captured) {
      const gain = captureGain(board, move);
      if (gain < 0) sacrifice = -gain;
    } else {
      sacrifice = seeAt(new Chess(move.after), move.to);
    }

    const previous = i > 0 ? history[i - 1] : null;
    const isRecapture = !!(move.captured && previous && previous.captured && previous.to === move.to);

    // Missed wins. Two shapes: a forced mate that is no longer forced after the move,
    // and a crushing advantage (where win% is saturated and hides the loss) that
    // shrank by a lot while staying clearly winning.
    const hadForcedMate = !!bestLine && bestLine.mate !== null && bestLine.mate !== undefined && bestLine.mate > 0;
    const stillMating = !!afterLine && afterLine.mate !== null && afterLine.mate !== undefined && afterLine.mate < 0;
    // After one move, an optimal continuation of "mate in N" is "mate in N-1". A mate
    // that is still forced but has grown by three moves or more was let slip too -
    // M2 turning into M9 is a missed win, not business as usual.
    const mateStretched = hadForcedMate && stillMating && -afterLine.mate - (bestLine.mate - 1) >= 3;
    const keptForcedMate = boardAfter.isCheckmate() || (stillMating && !mateStretched);
    const missedMate = hadForcedMate && !keptForcedMate && !isBest;
    const missedCrush =
      !hadForcedMate && !isBest && evalBeforeCp >= 800 && evalAfterCp >= 300 && evalBeforeCp - evalAfterCp >= 400;
    const missedWin = missedMate ? { kind: 'mate', mateIn: bestLine.mate } : missedCrush ? { kind: 'material' } : null;

    // Was the mover already inside a forced mate, and did this move hand the
    // opponent one that was not there before?
    const alreadyMated = !!bestLine && bestLine.mate !== null && bestLine.mate !== undefined && bestLine.mate < 0;
    const allowedMate =
      !!afterLine && afterLine.mate !== null && afterLine.mate !== undefined && afterLine.mate > 0 && !alreadyMated;

    const loss = effectiveLoss({
      isBest: isBest,
      winLoss: winLoss,
      evalBeforeCp: evalBeforeCp,
      evalAfterCp: evalAfterCp,
      missedWin: missedWin,
      allowedMate: allowedMate
    });

    const label = classify({
      winLoss: loss,
      isBest: isBest,
      legalCount: legalCount,
      gapToSecond: gapToSecond,
      evalBeforeCp: evalBeforeCp,
      evalAfterCp: evalAfterCp,
      sacrifice: sacrifice,
      isRecapture: isRecapture,
      missedWin: !!missedWin
    });



    const bestMove = bestUci ? uciToMove(new Chess(move.before), bestUci) : null;
    const bestSan = bestMove ? new Chess(move.before).move({ from: bestMove.from, to: bestMove.to, promotion: bestMove.promotion }).san : null;

    // Clock bookkeeping: PGN clocks are the time left *after* the move.
    const clock = parseClock(comments.get(move.after));
    let timeSpent = null;
    if (clock !== null && clockBySide[mover] !== null) {
      timeSpent = Math.max(0, clockBySide[mover] - clock + increment);
    }
    if (clock !== null) clockBySide[mover] = clock;

    moves.push({
      ply: i,
      moveNumber: Math.floor(i / 2) + 1,
      color: mover,
      san: move.san,
      uci: playedUci,
      from: move.from,
      to: move.to,
      piece: move.piece,
      captured: move.captured || null,
      fenBefore: move.before,
      fenAfter: move.after,
      label: label,
      winLoss: winLoss,
      accuracy: Math.min(accuracyFromWinLoss(loss), alreadyMated ? MATED_ACCURACY_CAP : 100),
      effectiveLoss: loss,
      missedWin: label.key === 'missedWin' ? missedWin : null,
      evalBeforeCp: evalBeforeCp,
      evalAfterCp: evalAfterCp,
      winBefore: winBefore,
      winAfter: winAfter,
      isBest: isBest,
      bestUci: bestUci,
      bestSan: bestSan,
      bestPvSan: bestLine ? pvToSan(move.before, bestLine.pv, 6) : [],
      bestScore: bestLine ? { cp: bestLine.cp, mate: bestLine.mate } : null,
      secondScore: secondLine ? { cp: secondLine.cp, mate: secondLine.mate } : null,
      // The opponent's best answer to what was actually played - this is what a
      // mistake "allows", and it is the most useful half of the explanation.
      replyPvSan: afterLine ? pvToSan(move.after, afterLine.pv, 6) : [],
      replyUci: afterLine && afterLine.pv.length ? afterLine.pv[0] : null,
      afterScore: afterLine ? { cp: afterLine.cp, mate: afterLine.mate } : null,
      sacrifice: sacrifice,
      phase: phaseOf(move.before, i),
      clock: clock,
      timeSpent: timeSpent,
      isCheck: /\+$/.test(move.san),
      isMate: /#$/.test(move.san)
    });
  }

  const byColor = {
    w: buildPlayerStats(moves.filter((m) => m.color === 'w')),
    b: buildPlayerStats(moves.filter((m) => m.color === 'b'))
  };

  return {
    headers: headers,
    moves: moves,
    stats: byColor,
    depth: depth,
    increment: increment
  };
}

/* ------------------------------------------------------------ mate hunt -- */

/**
 * Forced mates hide from shallow searches. Measured on games that ended in mate,
 * the winner's positions in the last six moves showed a mate score only 43% of the
 * time at depth 12 and 51% at depth 16 - so a "missed win" could never be reported,
 * because the analysis never knew the win was there.
 *
 * Deepening every position would be 15x slower. Instead, look again only where the
 * side to move is already clearly winning - which is exactly where missed mates
 * live - with a deeper search capped by time. Whenever that turns up a mate, the
 * position after the played move is deepened too, so "kept the mate or lost it" is
 * judged on equal terms.
 */
// Chosen against a depth-28 oracle on real checkmate games (scripts/matehunt-recall.mjs):
// depth+10 capped at 2.5s recovered 10 of 10 mates the shallow pass had missed, at
// ~1.4s per hunted position on one thread; depth+8 at 1.2s managed only 6 of 10.
// Only ~3 positions per game qualify, so the cost is a few seconds per review.
// +3 rather than +5: a shallow search that has not seen the combination yet can sit
// well below the true value, and the cap below keeps the cost bounded regardless -
// the highest evaluations are taken first, so widening the net costs nothing extra.
const MATE_HUNT_CP = 300;
const MATE_HUNT_EXTRA_DEPTH = 10;
const MATE_HUNT_MS = 2500;
// A game where one side is crushing for thirty moves would otherwise be hunted at
// every one of them. The biggest evaluations are where mates actually are, so take
// those first and stop at a budget; positions needed to judge a found mate are
// always added on top.
const MATE_HUNT_MAX = 18;

async function huntForMates(engine, positions, evals, depth, onProgress) {
  const isMate = (e) => !!(e && e.lines[0] && e.lines[0].mate !== null && e.lines[0].mate !== undefined);
  const winningHere = (e) => !!(e && e.lines[0] && !isMate(e) && (e.lines[0].cp || 0) >= MATE_HUNT_CP);

  const candidates = [];
  for (let i = 0; i < positions.length; i++) if (winningHere(evals[i])) candidates.push(i);
  candidates.sort((a, b) => evals[b].lines[0].cp - evals[a].lines[0].cp);
  const queue = candidates.slice(0, MATE_HUNT_MAX);

  // The time cap is per position of wall clock; more threads search more in it, so
  // the cap can come down without losing depth (speed-up is well short of linear).
  const threads = Math.max(1, engine.threads || 1);
  const movetime = Math.max(700, Math.round(MATE_HUNT_MS / Math.sqrt(threads)));

  const done = new Set();
  let looked = 0;
  while (queue.length) {
    const i = queue.shift();
    if (done.has(i)) continue;
    done.add(i);

    const deeper = await engine.analyse(positions[i], {
      depth: depth + MATE_HUNT_EXTRA_DEPTH,
      movetime: movetime,
      multipv: 1
    });
    looked++;
    if (onProgress) onProgress(positions.length + looked / Math.max(1, queue.length + looked), positions.length + 1);

    if (!isMate(deeper)) continue;
    // Keep the shallow second line (it feeds the "only move" test); swap in the mate.
    evals[i] = { lines: [deeper.lines[0]].concat(evals[i].lines.slice(1)), depth: deeper.depth, terminal: false };

    // The next position decides whether the mate was kept - it needs the same scrutiny.
    if (i + 1 < positions.length && !done.has(i + 1)) queue.unshift(i + 1);
  }
}

function buildPlayerStats(moves) {
  const counts = {};
  for (const key of Object.keys(LABELS)) counts[key] = 0;
  for (const m of moves) counts[m.label.key]++;

  const rawAccuracy = aggregateAccuracy(moves.map((m) => m.accuracy));
  const accuracy = calibrateAccuracy(rawAccuracy);

  const phases = {};
  for (const phase of ['opening', 'middlegame', 'endgame']) {
    const subset = moves.filter((m) => m.phase === phase);
    phases[phase] = subset.length
      ? {
          count: subset.length,
          accuracy: calibrateAccuracy(aggregateAccuracy(subset.map((m) => m.accuracy))),
          firstPly: subset[0].ply,
          lastPly: subset[subset.length - 1].ply
        }
      : null;
  }

  const times = moves.map((m) => m.timeSpent).filter((t) => t !== null);
  const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;

  return {
    moveCount: moves.length,
    counts: counts,
    accuracy: accuracy,
    rawAccuracy: rawAccuracy,
    phases: phases,
    averageTime: avgTime,
    hasClocks: times.length > 0
  };
}
