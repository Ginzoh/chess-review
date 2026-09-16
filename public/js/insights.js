/**
 * Turns the raw analysis into English: per-move explanations, and the
 * "what you did well / what to work on" review of the whole game.
 *
 * Every sentence in here is derived from something concrete - a capture the
 * engine found, a piece left loose, an evaluation swing, a clock reading - so
 * the review can always point at the evidence behind it.
 */

import { cpToWinPercent } from './analysis.js';
import { estimateRating } from './rating.js';
import {
  Chess,
  uciToMove,
  forkTargets,
  captureGain,
  seeAt,
  pieceName,
  materialPhrase,
  formatVariation,
  PIECE_VALUE
} from './chessutils.js';

/* ------------------------------------------------------------ formatting -- */

/**
 * Every evaluation the app prints is from White's point of view - the move list,
 * the readout under the board and the bar all agree on that. Per-move numbers are
 * stored from the mover's side, so text about a move goes through this to match.
 */
export function formatEval(move, cp) {
  return formatCp(move.color === 'w' ? cp : -cp);
}

export function formatCp(cp) {
  if (cp === null || cp === undefined) return '—';
  if (Math.abs(cp) >= 9000) {
    const n = Math.round((10000 - Math.abs(cp)) / 10);
    return (cp > 0 ? 'M' : '-M') + Math.max(1, n);
  }
  const pawns = cp / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2);
}

/**
 * Plain-English reading of an evaluation, always from White's point of view.
 * The number alone means little to most people; this says who is actually winning.
 */
export function advantagePhrase(whiteCp) {
  if (whiteCp === null || whiteCp === undefined) return '';
  if (Math.abs(whiteCp) >= 9000) {
    const n = Math.max(1, Math.round((10000 - Math.abs(whiteCp)) / 10));
    return (whiteCp > 0 ? 'White' : 'Black') + ' mates in ' + n;
  }
  const abs = Math.abs(whiteCp);
  if (abs < 30) return 'Equal';
  const side = whiteCp > 0 ? 'White' : 'Black';
  if (abs < 80) return side + ' is slightly better';
  if (abs < 150) return side + ' is better';
  if (abs < 300) return side + ' is clearly better';
  if (abs < 600) return side + ' is winning';
  return side + ' is completely winning';
}

/** White's expected score as a percentage, for "who is favoured" at a glance. */
export function whiteExpectedScore(whiteCp) {
  if (whiteCp === null || whiteCp === undefined) return null;
  if (Math.abs(whiteCp) >= 9000) return whiteCp > 0 ? 100 : 0;
  return Math.round(cpToWinPercent(whiteCp));
}

export function formatSeconds(s) {
  if (s === null || s === undefined) return '';
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + Math.round(s % 60) + 's';
}

function moveLabelText(move) {
  return move.moveNumber + (move.color === 'w' ? '.' : '...') + ' ' + move.san;
}

function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return items[0] + ' and ' + items[1];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/* --------------------------------------------------- describing one move -- */

/**
 * Say what a move actually does on the board: what it takes, what it hits,
 * what it rescues. Returns { san, facts: string[] }.
 */
export function describeMove(fen, uci) {
  const board = new Chess(fen);
  const mv = uciToMove(board, uci);
  if (!mv) return null;

  const gain = mv.captured ? captureGain(board, mv) : 0;
  const after = new Chess(fen);
  const made = after.move({ from: mv.from, to: mv.to, promotion: mv.promotion });

  const facts = [];

  if (after.isCheckmate()) {
    facts.push('is checkmate');
  } else {
    if (mv.captured) {
      if (gain >= 1) facts.push('wins ' + materialPhrase(gain));
      else facts.push('takes the ' + pieceName(mv.captured) + ' on ' + mv.to);
    }
    if (mv.promotion) facts.push('promotes to a ' + pieceName(mv.promotion));

    const forks = forkTargets(after, mv.to);
    if (forks.length >= 2) {
      const names = forks.map((f) => 'the ' + pieceName(f.type) + ' on ' + f.square);
      facts.push('hits ' + joinList(names.slice(0, 3)) + ' at once');
    } else if (forks.length === 1 && forks[0].type !== 'k' && !mv.captured) {
      // A lone king "target" is just the check we are about to mention anyway.
      facts.push('attacks the ' + pieceName(forks[0].type) + ' on ' + forks[0].square);
    }

    if (after.isCheck() && !facts.some((f) => f.indexOf('checkmate') !== -1)) facts.push('gives check');

    // Was the piece it moved actually in danger where it stood?
    if (!mv.captured) {
      const rescued = wasHanging(fen, mv.from);
      const safeNow = seeAt(new Chess(after.fen()), mv.to) <= 0;
      if (rescued >= 1 && safeNow) facts.push('saves the ' + pieceName(mv.piece) + ' from being won');
    }

    // Did it shore up something that was loose? Only worth saying about a real
    // piece - "rescues a pawn" is noise next to the rest of the sentence.
    // Skipped after a check, where the forced replies make everything look safe.
    if (facts.length < 3 && !after.isCheck()) {
      const savedElsewhere = defendedSomething(fen, after, mv);
      if (savedElsewhere) {
        facts.push('takes the pressure off the ' + pieceName(savedElsewhere.type) + ' on ' + savedElsewhere.square);
      }
    }
  }

  return { san: made.san, facts: facts.slice(0, 3), gain: gain };
}

/** Could the opponent have won the piece standing on `square`, if it were their turn? */
function wasHanging(fen, square) {
  const flipped = flipSideToMove(fen);
  if (!flipped) return 0;
  try {
    return seeAt(new Chess(flipped), square);
  } catch (e) {
    return 0;
  }
}

function flipSideToMove(fen) {
  const parts = fen.split(' ');
  if (parts.length < 6) return null;
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-'; // en passant square is meaningless once the turn flips
  return parts.join(' ');
}

/** A friendly piece that was loose before the move and is safe after it. */
function defendedSomething(fenBefore, boardAfter, mv) {
  const flipped = flipSideToMove(fenBefore);
  if (!flipped) return null;
  let before;
  try {
    before = new Chess(flipped);
  } catch (e) {
    return null;
  }
  for (const row of before.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== mv.color || sq.square === mv.from) continue;
      if (sq.type === 'k' || sq.type === 'p') continue; // pawns are too cheap to be worth a clause
      if (seeAt(new Chess(flipped), sq.square) <= 0) continue;
      if (seeAt(new Chess(boardAfter.fen()), sq.square) <= 0) return { square: sq.square, type: sq.type };
    }
  }
  return null;
}

function factsToSentence(san, description) {
  if (!description || !description.facts.length) return san;
  return san + ' ' + joinList(description.facts);
}

/** Same facts, but as a relative clause: "Nb3, which attacks the bishop on c5". */
function factsToClause(san, description) {
  if (!description || !description.facts.length) return san;
  return san + ', which ' + joinList(description.facts);
}

/* ------------------------------------------------- per-move explanation -- */

const ERROR_KINDS = {
  hangs: 'left pieces undefended',
  allowsTactic: 'allowed tactics',
  allowsMate: 'allowed forced mates',
  missedMate: 'missed forced mates',
  missedWin: 'let winning positions slip',
  missedMaterial: 'missed free material',
  positional: 'made slow positional concessions'
};

/** Classify *why* a move was bad, which is what makes patterns across a game visible. */
export function errorKind(move) {
  if (!move.bestUci) return null;
  if (move.missedWin) return move.missedWin.kind === 'mate' ? 'missedMate' : 'missedWin';
  const opponentMates = move.afterScore && move.afterScore.mate !== null && move.afterScore.mate !== undefined && move.afterScore.mate > 0;
  const couldHaveMated = move.bestScore && move.bestScore.mate !== null && move.bestScore.mate !== undefined && move.bestScore.mate > 0;

  if (opponentMates) return 'allowsMate';
  if (couldHaveMated) return 'missedMate';

  // What does the opponent's best reply win?
  if (move.replyUci) {
    const board = new Chess(move.fenAfter);
    const reply = uciToMove(board, move.replyUci);
    if (reply && reply.captured) {
      const gain = captureGain(board, reply);
      if (gain >= 1.5) return 'hangs';
      if (gain >= 0.9) return 'hangs';
    }
  }

  // Was there free material sitting there for us?
  const board = new Chess(move.fenBefore);
  const best = uciToMove(board, move.bestUci);
  if (best && best.captured && captureGain(board, best) >= 1.5) return 'missedMaterial';
  if (move.evalBeforeCp >= 200 && move.evalAfterCp < 50) return 'missedWin';
  if (move.winLoss >= 10) return 'allowsTactic';
  return 'positional';
}

/** Did the move capture into a recapture that wins back more than it took? */
function isLosingRecapture(move) {
  if (!move.captured || !move.replyUci) return false;
  if (move.replyUci.slice(2, 4) !== move.to) return false;
  return PIECE_VALUE[move.piece] > PIECE_VALUE[move.captured];
}

/**
 * The annotation shown next to a move in the list. Full sentences, always
 * grounded in the engine lines we already computed.
 */
export function explainMove(move) {
  const parts = [];
  const kind = move.isBest ? null : errorKind(move);

  if (move.label.key === 'brilliant') {
    const d = describeMove(move.fenBefore, move.uci);
    parts.push(
      'A genuine sacrifice: ' + factsToSentence(move.san, d) + ', offering the ' + pieceName(move.piece) +
      ' for an attack the engine agrees is worth more than the material.'
    );
  } else if (move.label.key === 'great') {
    parts.push(move.san + ' was the one move that held the position together — the alternatives were clearly worse.');
  } else if (move.label.key === 'best') {
    const d = describeMove(move.fenBefore, move.uci);
    parts.push(d && d.facts.length ? 'Best move: ' + factsToSentence(move.san, d) + '.' : 'The engine\'s first choice.');
  } else if (move.label.key === 'forced') {
    parts.push('The only legal move.');
  } else if (move.label.key === 'missedWin') {
    if (move.missedWin && move.missedWin.kind === 'mate') {
      parts.push(
        'There was a forced mate in ' + move.missedWin.mateIn + ' here' +
        (move.bestPvSan.length ? ' with ' + formatVariation(move.fenBefore, move.bestPvSan) : '') +
        '. ' + move.san + ' lets it go — you are still winning at ' + formatEval(move, move.evalAfterCp) +
        ', but the win has to be found all over again.'
      );
    } else {
      const bestDesc = move.bestUci ? describeMove(move.fenBefore, move.bestUci) : null;
      parts.push(
        (bestDesc && bestDesc.facts.length ? bestDesc.san + ' ' + joinList(bestDesc.facts) : (move.bestSan || 'The engine move') + ' was crushing') +
        ', worth ' + formatEval(move, move.evalBeforeCp) + '. After ' + move.san + ' you are still clearly better at ' +
        formatEval(move, move.evalAfterCp) + ', but a large part of the advantage is gone.'
      );
    }
  } else if (move.label.key === 'excellent' || move.label.key === 'good') {
    if (move.winLoss < 1) parts.push('Accurate — as good as the engine\'s own move in practice.');
    else if (move.bestSan) parts.push('A sound choice; the engine would have played ' + move.bestSan + '.');
    else parts.push('A sound choice.');
  } else {
    // Inaccuracy, mistake or blunder: say what it allowed, then what to play instead.
    if (kind === 'allowsMate') {
      const mateIn = move.afterScore.mate;
      parts.push(
        move.san + ' walks into a forced mate in ' + mateIn + ' starting with ' +
        (move.replyPvSan[0] || 'the engine line') + '.'
      );
    } else if (move.replyUci && isLosingRecapture(move)) {
      // "Nxd2 wins a rook" is true but misleading when the rook had just taken
      // something itself. Describe the trade instead.
      const replyDesc = describeMove(move.fenAfter, move.replyUci);
      parts.push(
        move.san + ' allows ' + (replyDesc ? replyDesc.san : 'the recapture') + ', and trading your ' +
        pieceName(move.piece) + ' for a ' + pieceName(move.captured) + ' comes out badly.'
      );
    } else if (move.replyUci) {
      const replyDesc = describeMove(move.fenAfter, move.replyUci);
      if (replyDesc && replyDesc.facts.length) {
        parts.push(move.san + ' allows ' + factsToClause(replyDesc.san, replyDesc) + '.');
      } else {
        parts.push(move.san + ' hands the initiative over; ' + (replyDesc ? replyDesc.san : 'the reply') + ' is strong.');
      }
    }

    if (move.bestSan && move.bestUci !== move.uci) {
      const bestDesc = describeMove(move.fenBefore, move.bestUci);
      if (kind === 'missedMate') {
        parts.push('There was mate in ' + move.bestScore.mate + ' with ' + formatVariation(move.fenBefore, move.bestPvSan) + '.');
      } else if (bestDesc && bestDesc.facts.length) {
        parts.push('Instead ' + factsToSentence(bestDesc.san, bestDesc) + '.');
      } else {
        parts.push('Better was ' + move.bestSan + ', keeping the evaluation at ' + formatEval(move, move.evalBeforeCp) + '.');
      }
    }

    parts.push('Evaluation: ' + formatEval(move, move.evalBeforeCp) + ' → ' + formatEval(move, move.evalAfterCp) + '.');
  }

  return { text: parts.filter(Boolean).join(' '), kind: kind };
}

/* ------------------------------------------------------- the full review -- */

const RESULT_TEXT = {
  '1-0': 'White won',
  '0-1': 'Black won',
  '1/2-1/2': 'the game was drawn'
};

/**
 * @param {object} analysis  output of analyseGame
 * @param {'w'|'b'} color    the player being reviewed
 * @param {object} meta      { white, black, result, termination, opening, timeClass }
 */
export function buildReview(analysis, color, meta) {
  const stats = analysis.stats[color];
  const mine = analysis.moves.filter((m) => m.color === color);
  const theirs = analysis.moves.filter((m) => m.color !== color);
  const opponentColor = color === 'w' ? 'b' : 'w';

  const review = {
    headline: buildHeadline(analysis, color, meta, stats),
    strengths: [],
    improvements: [],
    keyMoments: [],
    phases: buildPhaseNotes(stats, analysis, color),
    opening: buildOpeningNote(analysis, color, meta),
    time: null
  };

  /* ---- what went well ---- */

  const brilliants = mine.filter((m) => m.label.key === 'brilliant');
  if (brilliants.length) {
    review.strengths.push({
      title: brilliants.length === 1 ? 'You found a brilliant sacrifice' : 'You found ' + brilliants.length + ' brilliant sacrifices',
      detail: brilliants.map((m) => moveLabelText(m) + ' — ' + explainMove(m).text).join(' '),
      ply: brilliants[0].ply
    });
  }

  const greats = mine.filter((m) => m.label.key === 'great');
  if (greats.length) {
    review.strengths.push({
      title: 'You found the only move ' + (greats.length === 1 ? 'once' : greats.length + ' times'),
      detail:
        'At ' + joinList(greats.map(moveLabelText)) + ' every other move let the position slip. Spotting forced, ' +
        'single-answer positions is one of the hardest things to do over the board.',
      ply: greats[0].ply
    });
  }

  const topMoves = mine.filter((m) => m.isBest).length;
  const topRate = mine.length ? topMoves / mine.length : 0;
  if (topRate >= 0.4 && mine.length >= 10) {
    review.strengths.push({
      title: 'You matched the engine on ' + Math.round(topRate * 100) + '% of your moves',
      detail: topMoves + ' of your ' + mine.length + ' moves were the engine\'s top choice.',
      ply: null
    });
  }

  const streak = longestCleanStreak(mine);
  if (streak && streak.length >= 6) {
    review.strengths.push({
      title: streak.length + ' accurate moves in a row',
      detail:
        'From move ' + streak.from.moveNumber + ' to move ' + streak.to.moveNumber +
        ' you did not give away anything meaningful. That stretch was the backbone of your game.',
      ply: streak.from.ply
    });
  }

  const punishes = findPunishments(analysis, color);
  if (punishes.length) {
    const p = punishes[0];
    review.strengths.push({
      title: 'You punished the mistake on move ' + p.mistake.moveNumber,
      detail:
        'After ' + moveLabelText(p.mistake) + ' (' + p.mistake.label.text.toLowerCase() + ') you replied ' +
        moveLabelText(p.punish) + ', which was the engine\'s choice. ' +
        'Converting an opponent\'s error immediately is exactly what separates results at every level.',
      ply: p.punish.ply
    });
  }

  const tactics = mine.filter((m) => m.isBest && m.captured && m.winAfter - m.winBefore > -1 && capturedValue(m) >= 1.5);
  if (tactics.length && !punishes.length) {
    const t = tactics[tactics.length - 1];
    const d = describeMove(t.fenBefore, t.uci);
    review.strengths.push({
      title: 'You spotted the tactic on move ' + t.moveNumber,
      detail: factsToSentence(t.san, d) + '.',
      ply: t.ply
    });
  }

  const defense = findBestDefensiveStretch(mine);
  if (defense) {
    review.strengths.push({
      title: 'You fought back from a worse position',
      detail:
        'Around move ' + defense.moveNumber + ' the evaluation stood at ' + formatCp(color === 'w' ? defense.from : -defense.from) +
        ' against you, and you dragged it back to ' + formatCp(color === 'w' ? defense.to : -defense.to) +
        '. Holding a bad position is a skill in itself.',
      ply: defense.ply
    });
  }

  const conversion = findConversion(analysis, color, meta);
  if (conversion) review.strengths.push(conversion);

  const bestPhase = pickPhase(stats, 'best');
  if (bestPhase && bestPhase.data.accuracy >= 80 && bestPhase.data.count >= 5) {
    review.strengths.push({
      title: 'Your ' + bestPhase.name + ' was your strongest phase',
      detail: 'You played the ' + bestPhase.name + ' at ' + bestPhase.data.accuracy.toFixed(1) + '% accuracy over ' + bestPhase.data.count + ' moves.',
      ply: bestPhase.data.firstPly
    });
  }

  if (stats.counts.blunder === 0 && stats.counts.mistake === 0 && stats.counts.missedWin === 0 && mine.length >= 15) {
    review.strengths.push({
      title: 'No mistakes or blunders',
      detail: 'Across ' + mine.length + ' moves you never handed over more than a small edge. Clean games are rarer than good ones.',
      ply: null
    });
  }

  /* ---- what to work on ---- */

  const errors = mine
    .filter((m) => ['inaccuracy', 'mistake', 'blunder'].indexOf(m.label.key) !== -1)
    .sort((a, b) => b.winLoss - a.winLoss);

  for (const m of errors.slice(0, 3)) {
    const explained = explainMove(m);
    review.improvements.push({
      title: m.label.text + ' on move ' + m.moveNumber + ': ' + m.san,
      detail: explained.text,
      kind: explained.kind,
      ply: m.ply,
      winLoss: m.winLoss
    });
  }

  const listed = errors.slice(0, 3);

  // Missed wins are listed as a group: three missed mates is one lesson, not three.
  const misses = mine.filter((m) => m.label.key === 'missedWin');
  if (misses.length) {
    const mates = misses.filter((m) => m.missedWin && m.missedWin.kind === 'mate');
    const first = misses[0];
    const where = joinList(misses.map((m) => moveLabelText(m)));
    review.improvements.push({
      title: misses.length === 1
        ? 'Missed win on move ' + first.moveNumber
        : 'You let a forced win slip ' + misses.length + ' times',
      detail:
        (mates.length
          ? 'There was a forced mate on the board at ' + where + ' and it was not played. '
          : 'A decisive continuation was available at ' + where + '. ') +
        explainMove(first).text +
        (misses.length > 1
          ? ' Winning positions still have to be won: when the engine bar is pinned to the top, look for the ' +
            'forcing line - checks and captures first - instead of a safe move.'
          : ''),
      kind: mates.length ? 'missedMate' : 'missedWin',
      ply: first.ply,
      winLoss: first.winLoss
    });
  }

  const missedWins = mine.filter((m) => {
    if (m.isBest || m.winLoss < 5 || listed.indexOf(m) !== -1 || m.label.key === 'missedWin') return false;
    const kind = errorKind(m);
    return kind === 'missedMate' || kind === 'missedWin' || kind === 'missedMaterial';
  });
  if (missedWins.length) {
    const m = missedWins[0];
    review.improvements.push({
      title: 'Missed chance on move ' + m.moveNumber,
      detail: explainMove(m).text,
      kind: errorKind(m),
      ply: m.ply,
      winLoss: m.winLoss
    });
  }

  const pattern = findErrorPattern(mine);
  if (pattern) review.improvements.push(pattern);

  const timeNote = buildTimeNote(mine, stats);
  if (timeNote) {
    review.time = timeNote;
    if (timeNote.isProblem) review.improvements.push(timeNote);
  }

  const worstPhase = pickPhase(stats, 'worst');
  if (worstPhase && worstPhase.data.accuracy < 72 && worstPhase.data.count >= 5) {
    review.improvements.push({
      title: 'The ' + worstPhase.name + ' cost you the most',
      detail:
        'Your ' + worstPhase.name + ' accuracy was ' + worstPhase.data.accuracy.toFixed(1) + '% across ' + worstPhase.data.count +
        ' moves — well below your ' + stats.accuracy.toFixed(1) + '% for the game. That is the phase to study from this one.',
      kind: 'phase',
      ply: worstPhase.data.firstPly
    });
  }

  if (!review.improvements.length) {
    const worst = mine.slice().sort((a, b) => b.winLoss - a.winLoss)[0];
    review.improvements.push({
      title: 'Very little to fix',
      detail: worst
        ? 'Your least accurate moment was ' + moveLabelText(worst) + ', and even that only cost ' + worst.winLoss.toFixed(1) +
          '% of expected score. ' + (worst.bestSan ? 'The engine preferred ' + worst.bestSan + '.' : '')
        : 'The engine found nothing worth criticising.',
      kind: 'positional',
      ply: worst ? worst.ply : null
    });
  }

  /* ---- key moments (both sides) ---- */

  review.keyMoments = analysis.moves
    .map((m) => ({ move: m, swing: Math.abs(m.winAfter - m.winBefore) }))
    .filter((x) => x.swing >= 8)
    .sort((a, b) => b.swing - a.swing)
    .slice(0, 4)
    .sort((a, b) => a.move.ply - b.move.ply)
    .map((x) => {
      const m = x.move;
      const isMine = m.color === color;
      const goodForMe = isMine ? m.winAfter > m.winBefore : m.winAfter < m.winBefore;
      return {
        ply: m.ply,
        title: moveLabelText(m) + ' — ' + m.label.text,
        detail:
          (isMine ? 'Your move. ' : 'Your opponent\'s move. ') +
          explainMove(m).text +
          ' The position swung ' + (goodForMe ? 'in your favour' : 'against you') + ' by ' + Math.round(x.swing) + ' points of expected score.',
        favourable: goodForMe
      };
    });

  return review;
}

/* ------------------------------------------------------------- helpers -- */

function capturedValue(move) {
  const board = new Chess(move.fenBefore);
  const mv = uciToMove(board, move.uci);
  return mv ? captureGain(board, mv) : 0;
}

function buildHeadline(analysis, color, meta, stats) {
  const me = color === 'w' ? meta.white : meta.black;
  const them = color === 'w' ? meta.black : meta.white;
  const resultForMe =
    meta.result === '1/2-1/2' ? 'drew' : (meta.result === '1-0') === (color === 'w') ? 'won' : 'lost';

  const bits = [];
  bits.push(
    'Playing ' + (color === 'w' ? 'White' : 'Black') + ' against ' + them.username +
    (them.rating ? ' (' + them.rating + ')' : '') + ', you ' + resultForMe +
    (meta.termination ? ' — ' + meta.termination.toLowerCase() : '') + '.'
  );
  bits.push('Accuracy ' + (stats.accuracy === null ? '—' : stats.accuracy.toFixed(1) + '%') + ' over ' + stats.moveCount + ' moves.');

  const estimate = estimateRating({
    accuracy: stats.accuracy,
    timeClass: meta.timeClass,
    moveCount: stats.moveCount
  });
  if (estimate && estimate.available) {
    bits.push(
      'That accuracy is what a ~' + estimate.rating + ' player typically posts' +
      (me.rating ? ' (you are rated ' + me.rating + ')' : '') +
      ' — it would be a good game for a ' + estimate.low + ' and a poor one for a ' + estimate.high +
      '. One game swings a lot, so read it as a range.'
    );
  }

  const c = stats.counts;
  const errorBits = [];
  if (c.blunder) errorBits.push(c.blunder + ' blunder' + (c.blunder > 1 ? 's' : ''));
  if (c.missedWin) errorBits.push(c.missedWin + ' missed win' + (c.missedWin > 1 ? 's' : ''));
  if (c.mistake) errorBits.push(c.mistake + ' mistake' + (c.mistake > 1 ? 's' : ''));
  if (c.inaccuracy) errorBits.push(c.inaccuracy + ' inaccurac' + (c.inaccuracy > 1 ? 'ies' : 'y'));
  bits.push(errorBits.length ? 'The engine flagged ' + joinList(errorBits) + '.' : 'The engine flagged nothing worse than a good move.');

  return bits.join(' ');
}

function buildPhaseNotes(stats, analysis, color) {
  const out = [];
  for (const name of ['opening', 'middlegame', 'endgame']) {
    const data = stats.phases[name];
    if (!data) continue;
    out.push({
      name: name,
      accuracy: data.accuracy,
      count: data.count,
      firstPly: data.firstPly
    });
  }
  return out;
}

function buildOpeningNote(analysis, color, meta) {
  if (!meta.opening) return null;
  const stats = analysis.stats[color];
  const openingStats = stats.phases.opening;
  const first = analysis.moves.filter((m) => m.color === color && m.phase === 'opening');
  // Preferring 1. b3 to 1. e4 is a choice of opening, not a mistake to report.
  const firstSlip = first.find((m) => m.winLoss >= (m.ply < 6 ? 10 : 5));

  let detail = 'You played the ' + meta.opening + '.';
  if (openingStats) detail += ' Your opening accuracy was ' + openingStats.accuracy.toFixed(1) + '%.';
  if (firstSlip) {
    detail += ' The first move to cost anything was ' + moveLabelText(firstSlip) + (firstSlip.bestSan ? ', where ' + firstSlip.bestSan + ' was better.' : '.');
  } else if (openingStats) {
    detail += ' You came out of the opening without giving anything away.';
  }

  return { name: meta.opening, url: meta.openingUrl, detail: detail, ply: firstSlip ? firstSlip.ply : 0 };
}

function longestCleanStreak(moves) {
  let best = null;
  let start = null;
  let count = 0;

  const flush = (endIndex) => {
    if (count >= 4 && (!best || count > best.length)) {
      best = { length: count, from: moves[start], to: moves[endIndex - 1] };
    }
    start = null;
    count = 0;
  };

  for (let i = 0; i < moves.length; i++) {
    if (moves[i].winLoss < 5) {
      if (start === null) start = i;
      count++;
    } else {
      flush(i);
    }
  }
  flush(moves.length);
  return best;
}

/** Cases where the opponent erred and the player answered with the engine's move. */
function findPunishments(analysis, color) {
  const out = [];
  for (let i = 1; i < analysis.moves.length; i++) {
    const prev = analysis.moves[i - 1];
    const cur = analysis.moves[i];
    if (cur.color !== color) continue;
    const prevWasBad = ['mistake', 'blunder'].indexOf(prev.label.key) !== -1;
    // Only a punishment if it actually left the player standing - answering a
    // "mistake" while still being mated is not something to praise.
    if (prevWasBad && cur.isBest && cur.evalAfterCp >= -100) {
      out.push({ mistake: prev, punish: cur, swing: prev.winLoss });
    }
  }
  return out.sort((a, b) => b.swing - a.swing);
}

function findBestDefensiveStretch(moves) {
  let best = null;
  for (let i = 0; i < moves.length; i++) {
    // Worse, but not already resignable - clawing back from -23 to -18 is not a comeback.
    if (moves[i].evalBeforeCp > -150 || moves[i].evalBeforeCp < -600) continue;
    for (let j = i; j < Math.min(moves.length, i + 12); j++) {
      const delta = moves[j].evalAfterCp - moves[i].evalBeforeCp;
      // And it has to end somewhere playable.
      if (moves[j].evalAfterCp < -150) continue;
      if (delta >= 150 && (!best || delta > best.delta)) {
        best = {
          delta: delta,
          from: moves[i].evalBeforeCp,
          to: moves[j].evalAfterCp,
          moveNumber: moves[i].moveNumber,
          ply: moves[i].ply
        };
      }
    }
  }
  return best;
}

function findConversion(analysis, color, meta) {
  const won = (meta.result === '1-0') === (color === 'w') && meta.result !== '1/2-1/2';
  if (!won) return null;
  const mine = analysis.moves.filter((m) => m.color === color);
  const firstWinning = mine.find((m) => m.evalAfterCp >= 200);
  if (!firstWinning) return null;
  const after = mine.filter((m) => m.ply > firstWinning.ply);
  if (after.length < 4) return null;
  const slips = after.filter((m) => m.winLoss >= 10).length;
  if (slips > 1) return null;
  return {
    title: 'You converted cleanly',
    detail:
      'You were winning from move ' + firstWinning.moveNumber + ' (' + formatEval(firstWinning, firstWinning.evalAfterCp) + ') and ' +
      (slips === 0
        ? 'never let it slip once over the remaining ' + after.length + ' moves.'
        : 'only wobbled once over the remaining ' + after.length + ' moves.'),
    ply: firstWinning.ply
  };
}

function pickPhase(stats, which) {
  const entries = [];
  for (const name of ['opening', 'middlegame', 'endgame']) {
    const data = stats.phases[name];
    if (data && data.accuracy !== null) entries.push({ name: name, data: data });
  }
  if (entries.length < 2) return null;
  entries.sort((a, b) => b.data.accuracy - a.data.accuracy);
  return which === 'best' ? entries[0] : entries[entries.length - 1];
}

function findErrorPattern(moves) {
  // The first few moves are opening choice, not a habit worth correcting.
  const errors = moves.filter((m) => m.ply >= 6 && ['mistake', 'blunder', 'inaccuracy', 'missedWin'].indexOf(m.label.key) !== -1);
  if (errors.length < 2) return null;

  const kinds = {};
  for (const m of errors) {
    const k = errorKind(m);
    if (!k) continue;
    (kinds[k] = kinds[k] || []).push(m);
  }

  let topKind = null;
  for (const k of Object.keys(kinds)) {
    if (kinds[k].length >= 2 && (!topKind || kinds[k].length > kinds[topKind].length)) topKind = k;
  }
  if (!topKind) return null;

  const group = kinds[topKind];
  const where = 'move' + (group.length > 1 ? 's ' : ' ') + joinList(group.map((m) => String(m.moveNumber)));

  const advice = {
    hangs: 'Before you commit to a move, check every piece you own that the opponent can touch — and check what your move stops defending.',
    missedMaterial: 'Scan for undefended enemy pieces and captures first, every move. Free material is the cheapest advantage there is.',
    missedMate: 'When the enemy king is exposed, count forcing moves — checks and captures — before anything quiet.',
    allowsMate: 'When your king has few defenders, treat every opponent check as a real threat and calculate it out.',
    allowsTactic: 'After picking a candidate move, ask what your opponent\'s most forcing reply would be.',
    missedWin: 'Winning positions need concrete lines, not general improvement — slow down when you are clearly better.',
    positional: 'These were slow concessions rather than tactical errors: think about piece activity and pawn structure.'
  };

  return {
    title: 'A repeating pattern: you ' + ERROR_KINDS[topKind],
    detail: 'This happened at ' + where + '. ' + (advice[topKind] || ''),
    kind: topKind,
    ply: group[0].ply,
    isPattern: true
  };
}

function buildTimeNote(moves, stats) {
  if (!stats.hasClocks || !stats.averageTime) return null;
  const timed = moves.filter((m) => m.timeSpent !== null);
  if (timed.length < 8) return null;

  const errors = timed.filter((m) => ['mistake', 'blunder'].indexOf(m.label.key) !== -1);
  const rushed = errors.filter((m) => m.timeSpent < Math.max(3, stats.averageTime * 0.4));

  const lowClock = timed.filter((m) => m.clock !== null && m.clock < 30);
  const errorsInTimeTrouble = errors.filter((m) => m.clock !== null && m.clock < 30);

  if (rushed.length >= 2) {
    return {
      title: 'Your worst moves were your fastest',
      detail:
        rushed.length + ' of your ' + errors.length + ' serious errors were played in under ' +
        formatSeconds(Math.max(3, stats.averageTime * 0.4)) + ', against an average of ' + formatSeconds(stats.averageTime) +
        ' per move (move' + (rushed.length > 1 ? 's ' : ' ') + joinList(rushed.map((m) => String(m.moveNumber))) + '). ' +
        'The time was there — the errors came from not using it.',
      kind: 'time',
      ply: rushed[0].ply,
      isProblem: true
    };
  }

  if (errorsInTimeTrouble.length >= 2 && lowClock.length) {
    return {
      title: 'Time trouble did the damage',
      detail:
        errorsInTimeTrouble.length + ' of your errors came with under 30 seconds on the clock. ' +
        'You spent an average of ' + formatSeconds(stats.averageTime) + ' per move — budgeting earlier would have left more for the critical moments.',
      kind: 'time',
      ply: errorsInTimeTrouble[0].ply,
      isProblem: true
    };
  }

  const longest = timed.slice().sort((a, b) => b.timeSpent - a.timeSpent)[0];
  return {
    title: 'Time use',
    detail:
      'You averaged ' + formatSeconds(stats.averageTime) + ' per move, and thought longest on move ' + longest.moveNumber +
      ' (' + formatSeconds(longest.timeSpent) + ', ' + longest.san + ' — ' + longest.label.text.toLowerCase() + ').',
    kind: 'time',
    ply: longest.ply,
    isProblem: false
  };
}
