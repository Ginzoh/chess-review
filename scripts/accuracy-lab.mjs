/**
 * Accuracy lab: which per-move scoring and aggregation best matches Chess.com's
 * game accuracy, game by game?
 *
 * Step 1 (slow, cached): analyse the calibration games once and store per-move
 * evaluations. Step 2 (fast): score every candidate formula against Chess.com's
 * published accuracy for those games. A held-out game is reported separately so a
 * formula cannot be judged on the data it was tuned on.
 *
 *   node scripts/accuracy-lab.mjs            # uses cached moves if present
 *   node scripts/accuracy-lab.mjs --refresh  # re-analyse
 */

import fs from 'fs';
import { CliEngine } from './cli-engine.mjs';
import { analyseGame, cpToWinPercent } from '../public/js/analysis.js';

const GAMES_FILE = 'scripts/data/calibration-games.json';
const MOVES_FILE = 'scripts/data/calibration-moves.json';
const DEPTH = Number(process.env.DEPTH || 12);

/* The game that prompted this: Chess.com says 69.19 / 52.98, we said 90.0 / 85.9. */
const HELD_OUT = {
  pgn:
    '[Event "Live Chess"]\n[White "ginzo001"]\n[Black "natha-19"]\n[Result "1-0"]\n[TimeControl "600"]\n\n' +
    '1. e4 e5 2. Nc3 Nf6 3. f4 exf4 4. e5 Ng8 5. Nf3 Bb4 6. d4 Bxc3+ 7. bxc3 Qe7 8. Bxf4 Qa3 9. Rb1 Qxc3+ ' +
    '10. Bd2 Qa3 11. Bc4 Nc6 12. Ng5 b5 13. Bxf7+ Ke7 14. d5 Nxe5 15. Bb4+ Qxb4+ 16. Rxb4 Nxf7 17. Qe2+ Kd6 ' +
    '18. Ne4+ Kxd5 19. Qd3+ Ke6 20. Qb3+ d5 21. Nc5+ Kd6 22. Rxb5 Ne5 23. O-O a6 24. Ne4+ dxe4 25. Qd5+ Ke7 ' +
    '26. Qxe5+ Be6 27. Qxc7+ Ke8 28. Qc6+ Bd7 29. Qxa8+ 1-0',
  timeClass: 'rapid',
  white: { rating: 512, accuracy: 69.19 },
  black: { rating: 500, accuracy: 52.98 }
};

/* ------------------------------------------------------ step 1: analyse -- */

function slimMoves(analysis) {
  return analysis.moves.map((m) => ({
    color: m.color,
    isBest: m.isBest,
    forced: m.label.key === 'forced',
    evalBeforeCp: m.evalBeforeCp,
    evalAfterCp: m.evalAfterCp,
    winBefore: m.winBefore,
    winAfter: m.winAfter,
    missedWin: m.missedWin ? m.missedWin.kind : null,
    mateBefore: m.bestScore && m.bestScore.mate !== null && m.bestScore.mate !== undefined ? m.bestScore.mate : null,
    // From the mover's side: negative means the opponent now has a forced mate.
    mateAfter: m.afterScore && m.afterScore.mate !== null && m.afterScore.mate !== undefined ? -m.afterScore.mate : null
  }));
}

let data;
if (fs.existsSync(MOVES_FILE) && !process.argv.includes('--refresh')) {
  data = JSON.parse(fs.readFileSync(MOVES_FILE, 'utf8'));
  console.log('using cached per-move data for ' + data.games.length + ' games (+ held-out)\n');
} else {
  const games = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
  const engine = new CliEngine();
  await engine.boot();
  data = { depth: DEPTH, games: [], heldOut: null };
  for (const [i, g] of games.entries()) {
    const a = await analyseGame(engine, g.pgn, { depth: DEPTH }, () => {});
    data.games.push({ timeClass: g.timeClass, white: g.white, black: g.black, moves: slimMoves(a) });
    process.stdout.write('  analysed ' + (i + 1) + '/' + games.length + '\r');
  }
  const h = await analyseGame(engine, HELD_OUT.pgn, { depth: DEPTH }, () => {});
  data.heldOut = { timeClass: HELD_OUT.timeClass, white: HELD_OUT.white, black: HELD_OUT.black, moves: slimMoves(h) };
  engine.quit();
  fs.writeFileSync(MOVES_FILE, JSON.stringify(data));
  console.log('\nanalysed and cached\n');
}

/* --------------------------------------------------- step 2: formulas -- */

const lichessAcc = (loss, c) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-(c || 0.04354) * Math.max(0, loss)) - 3.1669));

function stdev(v) {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

/** Aggregations over per-move accuracies. */
const AGG = {
  current: (accs, wins) => {
    const w = Math.max(2, Math.min(8, Math.ceil(wins.length / 10)));
    let ws = 0;
    let wt = 0;
    accs.forEach((a, i) => {
      const window = wins.slice(Math.max(0, i - w), Math.min(wins.length, i + w + 1));
      const weight = Math.max(0.5, Math.min(12, stdev(window)));
      ws += a * weight;
      wt += weight;
    });
    const weighted = wt ? ws / wt : 0;
    const harmonic = accs.length / accs.reduce((a, x) => a + 1 / Math.max(1, x), 0);
    return (weighted + harmonic) / 2;
  },
  mean: (accs) => accs.reduce((a, b) => a + b, 0) / accs.length,
  harmonic: (accs) => accs.length / accs.reduce((a, x) => a + 1 / Math.max(1, x), 0),
  geometric: (accs) => Math.exp(accs.reduce((a, x) => a + Math.log(Math.max(1, x)), 0) / accs.length),
  // Mean-heavy blends with the harmonic mean, which is what punishes a few disasters.
  blend80: (accs) => 0.8 * AGG.mean(accs) + 0.2 * AGG.harmonic(accs),
  blend65: (accs) => 0.65 * AGG.mean(accs) + 0.35 * AGG.harmonic(accs),
  // Moves in a decided position (either side past +/-8) count for half - once the
  // result is settled, playing the obvious move is not much of a test.
  decidedHalf: (accs, wins, moves) => {
    let ws = 0;
    let wt = 0;
    accs.forEach((a, i) => {
      const decided = Math.abs(moves[i].evalBeforeCp) >= 800;
      const w = decided ? 0.5 : 1;
      ws += a * w;
      wt += w;
    });
    return ws / wt;
  },
  // Forced moves left out entirely - there was no decision to grade.
  skipForced: (accs, wins, moves) => {
    const kept = accs.filter((a, i) => !moves[i].forced);
    return kept.length ? AGG.mean(kept) : AGG.mean(accs);
  }
};

/**
 * Per-move scoring candidates. Each returns an accuracy 0-100 for one move.
 *   m: slim move record. Evals are from the mover's side.
 */
const SCORE = {
  // What ships today: win% loss, with floors for missed wins.
  current: (m) => {
    if (m.isBest) return m.missedWin ? lichessAcc(m.missedWin === 'mate' ? 8 : 6) : 100;
    let loss = Math.max(0, m.winBefore - m.winAfter);
    if (m.missedWin) loss = Math.max(loss, m.missedWin === 'mate' ? 8 : 6);
    return lichessAcc(loss);
  },

  // Same, but the win% curve is computed on a flatter scale so that -5 -> -10
  // still registers. cp is scaled down before the logistic.
  flatter: (m, k) => {
    const f = (cp) => cpToWinPercent(Math.max(-1000, Math.min(1000, cp)) * k);
    const before = Math.abs(m.evalBeforeCp) >= 9000 ? (m.evalBeforeCp > 0 ? 100 : 0) : f(m.evalBeforeCp);
    const after = Math.abs(m.evalAfterCp) >= 9000 ? (m.evalAfterCp > 0 ? 100 : 0) : f(m.evalAfterCp);
    if (m.isBest) return m.missedWin ? lichessAcc(m.missedWin === 'mate' ? 8 : 6) : 100;
    let loss = Math.max(0, before - after);
    if (m.missedWin) loss = Math.max(loss, m.missedWin === 'mate' ? 8 : 6);
    return lichessAcc(loss);
  },

  // Win% loss, plus a floor from centipawn loss so a bad move in a decided
  // position still costs something: every 100cp lost is worth at least `perPawn`
  // points of win%, capped.
  cpFloor: (m, perPawn, matePenalty) => {
    if (m.isBest) return m.missedWin ? lichessAcc(m.missedWin === 'mate' ? 8 : 6) : 100;
    const cpLoss = Math.max(0, Math.min(1500, m.evalBeforeCp - m.evalAfterCp));
    // Allowing a forced mate from a position that had none is a blunder, full stop.
    const allowedMate = m.mateAfter !== null && m.mateAfter < 0 && !(m.mateBefore !== null && m.mateBefore < 0);
    let loss = Math.max(0, m.winBefore - m.winAfter);
    loss = Math.max(loss, (cpLoss / 100) * perPawn);
    if (allowedMate) loss = Math.max(loss, matePenalty || 25);
    if (m.missedWin) loss = Math.max(loss, m.missedWin === 'mate' ? 8 : 6);
    return lichessAcc(Math.min(loss, 60));
  },

  // Same floor, but evals are clamped to +/-1500 before differencing (a mate score is
  // not "99 pawns"), and a missed win keeps its own modest floor rather than being
  // scored as a catastrophe.
  cpFloorSane: (m, perPawn, missFloor, c) => {
    if (m.isBest) return m.missedWin ? lichessAcc(m.missedWin === 'mate' ? missFloor : missFloor - 2, c) : 100;
    const clamp = (v) => Math.max(-1500, Math.min(1500, v));
    const cpLoss = Math.max(0, clamp(m.evalBeforeCp) - clamp(m.evalAfterCp));
    const allowedMate = m.mateAfter !== null && m.mateAfter < 0 && !(m.mateBefore !== null && m.mateBefore < 0);
    let loss = Math.max(0, m.winBefore - m.winAfter);
    if (m.missedWin) {
      loss = Math.max(loss, m.missedWin === 'mate' ? missFloor : missFloor - 2);
    } else {
      loss = Math.max(loss, (cpLoss / 100) * perPawn);
      if (allowedMate) loss = Math.max(loss, 25);
    }
    return lichessAcc(Math.min(loss, 60), c);
  },

  // As cpFloorSane, but a move made while already inside a forced mate against you
  // cannot score above `cap` - when every move loses, "best" only means slowest.
  matedCap: (m, perPawn, missFloor, cap) => {
    const base = SCORE.cpFloorSane(m, perPawn, missFloor);
    const alreadyMated = m.mateBefore !== null && m.mateBefore < 0;
    return alreadyMated ? Math.min(base, cap) : base;
  },

  // Centipawns only - no win% term at all. Same shape everywhere on the board.
  pureCp: (m, perPawn, matePenalty) => {
    if (m.isBest) return m.missedWin ? lichessAcc(m.missedWin === 'mate' ? 8 : 6) : 100;
    const cpLoss = Math.max(0, Math.min(1500, m.evalBeforeCp - m.evalAfterCp));
    const allowedMate = m.mateAfter !== null && m.mateAfter < 0 && !(m.mateBefore !== null && m.mateBefore < 0);
    let loss = (cpLoss / 100) * perPawn;
    if (allowedMate) loss = Math.max(loss, matePenalty || 25);
    if (m.missedWin) loss = Math.max(loss, m.missedWin === 'mate' ? 8 : 6);
    return lichessAcc(Math.min(loss, 60));
  }
};

const CANDIDATES = [
  { name: 'current (ships)', score: (m) => SCORE.current(m), agg: 'current' },
  { name: 'current, mean', score: (m) => SCORE.current(m), agg: 'mean' }
];
// A grid over the ideas that showed promise, so the choice is made by the data.
for (const agg of ['mean', 'blend80', 'blend65', 'decidedHalf', 'skipForced', 'geometric', 'harmonic']) {
  for (const k of [3, 4, 5]) {
    CANDIDATES.push({ name: 'cpFloor k=' + k + ', ' + agg, score: (m) => SCORE.cpFloor(m, k, 25), agg });
  }
}
for (const agg of ['mean']) {
  for (const k of [3, 4, 5]) {
    for (const mf of [15, 25]) {
      for (const c of [0.0435, 0.06, 0.08, 0.1, 0.13]) {
        CANDIDATES.push({ name: 'sane k=' + k + ' miss=' + mf + ' c=' + c + ', ' + agg, score: (m) => SCORE.cpFloorSane(m, k, mf, c), agg });
      }
    }
  }
}

for (const cap of [90, 80, 70, 60, 40, 20]) {
  CANDIDATES.push({ name: 'matedCap ' + cap + ' (k=4 miss=25), mean', score: (m) => SCORE.matedCap(m, 4, 25, cap), agg: 'mean' });
}

function gameAccuracy(game, color, cand) {
  const mine = game.moves.filter((m) => m.color === color);
  if (!mine.length) return null;
  const accs = mine.map(cand.score);
  const wins = mine.map((m) => m.winAfter);
  return AGG[cand.agg](accs, wins, mine);
}

function evaluate(cand, games) {
  const pairs = [];
  for (const g of games) {
    for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
      const ours = gameAccuracy(g, color, cand);
      if (ours === null || typeof g[side].accuracy !== 'number') continue;
      pairs.push({ ours, theirs: g[side].accuracy });
    }
  }
  const n = pairs.length;
  const gaps = pairs.map((p) => p.ours - p.theirs);
  const mean = gaps.reduce((a, b) => a + b, 0) / n;
  const rmse = Math.sqrt(gaps.reduce((a, d) => a + d * d, 0) / n);
  const mx = pairs.reduce((a, p) => a + p.ours, 0) / n;
  const my = pairs.reduce((a, p) => a + p.theirs, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const p of pairs) {
    num += (p.ours - mx) * (p.theirs - my);
    dx += (p.ours - mx) ** 2;
    dy += (p.theirs - my) ** 2;
  }
  const r = num / Math.sqrt(dx * dy);
  const slope = num / dx;
  const intercept = my - slope * mx;
  // Error after the best linear map - what a calibration could still fix.
  const residual = Math.sqrt(pairs.reduce((a, p) => a + (p.theirs - (slope * p.ours + intercept)) ** 2, 0) / n);
  return { n, mean, rmse, r, slope, intercept, residual };
}

for (const cand of CANDIDATES) cand.fit = evaluate(cand, data.games);

const held = (cand) => {
  const w = gameAccuracy(data.heldOut, 'w', cand);
  const b = gameAccuracy(data.heldOut, 'b', cand);
  const map = (v) => cand.fit.slope * v + cand.fit.intercept;
  return { w, b, mw: map(w), mb: map(b) };
};

const ranked = CANDIDATES.slice().sort((a, b) => a.fit.residual - b.fit.residual);
console.log('ranked by residual after each candidate\'s own linear map (population fit, n=' + ranked[0].fit.n + ')');
console.log('held-out = ginzo001 vs natha-19, Chess.com says 69.2 / 53.0');
console.log('');
console.log('  candidate                          r    residual  gap  |  held-out raw     mapped   |  map');
for (const cand of ranked.slice(0, 16)) {
  const h = held(cand);
  console.log(
    '  ' + cand.name.padEnd(32) + cand.fit.r.toFixed(3).padStart(6) + cand.fit.residual.toFixed(1).padStart(9) +
    cand.fit.mean.toFixed(1).padStart(6) + '  |' + (h.w.toFixed(1) + ' / ' + h.b.toFixed(1)).padStart(14) +
    (h.mw.toFixed(1) + ' / ' + h.mb.toFixed(1)).padStart(14) +
    '   |  ' + cand.fit.slope.toFixed(3) + 'x' + (cand.fit.intercept >= 0 ? '+' : '') + cand.fit.intercept.toFixed(2)
  );
}
console.log('');
console.log('for reference:');
for (const name of ['current (ships)', 'current, mean']) {
  const cand = CANDIDATES.find((c) => c.name === name);
  const h = held(cand);
  console.log(
    '  ' + cand.name.padEnd(32) + cand.fit.r.toFixed(3).padStart(6) + cand.fit.residual.toFixed(1).padStart(9) +
    cand.fit.mean.toFixed(1).padStart(6) + '  |' + (h.w.toFixed(1) + ' / ' + h.b.toFixed(1)).padStart(14) +
    (h.mw.toFixed(1) + ' / ' + h.mb.toFixed(1)).padStart(14)
  );
}

/* ---- does the blend help the low end in general, or only the held-out game? ---- */

console.log('\nerror after each candidate\'s own map, split by how Chess.com rated the game:');
console.log('  candidate                    <60: n  bias  rmse   |  60-80: n  bias  rmse   |  >=80: n  bias  rmse');
for (const name of ['cpFloor k=4, mean', 'cpFloor k=4, blend80', 'cpFloor k=4, blend65', 'cpFloor k=4, harmonic', 'current (ships)']) {
  const cand = CANDIDATES.find((c) => c.name === name);
  const map = (v) => cand.fit.slope * v + cand.fit.intercept;
  const bands = { lo: [], mid: [], hi: [] };
  for (const g of data.games) {
    for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
      const ours = gameAccuracy(g, color, cand);
      if (ours === null) continue;
      const err = map(ours) - g[side].accuracy;
      const t = g[side].accuracy;
      (t < 60 ? bands.lo : t < 80 ? bands.mid : bands.hi).push(err);
    }
  }
  const stat = (arr) => {
    if (!arr.length) return '   -    -     -  ';
    const bias = arr.reduce((a, b) => a + b, 0) / arr.length;
    const rmse = Math.sqrt(arr.reduce((a, b) => a + b * b, 0) / arr.length);
    return String(arr.length).padStart(3) + bias.toFixed(1).padStart(6) + rmse.toFixed(1).padStart(6);
  };
  console.log('  ' + name.padEnd(28) + stat(bands.lo) + '   |     ' + stat(bands.mid) + '   |    ' + stat(bands.hi));
}

console.log('\nsteeper per-move curves (k=4, miss=25), all with a plain mean:');
console.log('  c        r    residual   slope   held-out mapped');
for (const c of [0.0435, 0.06, 0.08, 0.1, 0.13]) {
  const cand = CANDIDATES.find((x) => x.name === 'sane k=4 miss=25 c=' + c + ', mean');
  if (!cand) continue;
  const h = held(cand);
  console.log('  ' + String(c).padEnd(7) + cand.fit.r.toFixed(3).padStart(7) + cand.fit.residual.toFixed(1).padStart(9) +
    cand.fit.slope.toFixed(2).padStart(8) + ('   ' + h.mw.toFixed(1) + ' / ' + h.mb.toFixed(1)));
}

console.log('\nhow often would a user notice? |error| > 10 after the map, and the crushed-loser subset (Chess.com < 45):');
console.log('  candidate                      >10 off   >15 off   |  <45: n  bias  rmse');
for (const name of ['sane k=4 miss=25 c=0.0435, mean', 'cpFloor k=4, mean', 'cpFloor k=4, blend80', 'cpFloor k=3, blend80', 'current (ships)']) {
  const cand = CANDIDATES.find((c) => c.name === name);
  const map = (v) => cand.fit.slope * v + cand.fit.intercept;
  let over10 = 0;
  let over15 = 0;
  let n = 0;
  const crushed = [];
  for (const g of data.games) {
    for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
      const ours = gameAccuracy(g, color, cand);
      if (ours === null) continue;
      const err = map(ours) - g[side].accuracy;
      n++;
      if (Math.abs(err) > 10) over10++;
      if (Math.abs(err) > 15) over15++;
      if (g[side].accuracy < 45) crushed.push(err);
    }
  }
  const bias = crushed.reduce((a, b) => a + b, 0) / crushed.length;
  const rmse = Math.sqrt(crushed.reduce((a, b) => a + b * b, 0) / crushed.length);
  console.log('  ' + name.padEnd(32) + (over10 + '/' + n).padStart(7) + (over15 + '/' + n).padStart(10) +
    '   |    ' + String(crushed.length).padStart(3) + bias.toFixed(1).padStart(6) + rmse.toFixed(1).padStart(6));
}

/* The general set has almost no games where a forced mate ran for many moves, so
   it cannot judge how Chess.com scores "best" moves made inside one. A second set
   of checkmate games (harvest-mated-games.mjs + analyse-set.mjs) can. The map is
   fitted on the general set only, then applied unchanged to the mated set. */
const MATED_FILE = 'scripts/data/mated-moves.json';
const matedSet = fs.existsSync(MATED_FILE) ? JSON.parse(fs.readFileSync(MATED_FILE, 'utf8')).games : [];

function scoreSet(cand, games) {
  const map = (v) => cand.fit.slope * v + cand.fit.intercept;
  const errs = [];
  for (const g of games) for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
    const ours = gameAccuracy(g, color, cand);
    if (ours === null || typeof g[side].accuracy !== 'number') continue;
    const matedMoves = g.moves.filter((m) => m.color === color && m.mateBefore !== null && m.mateBefore < 0).length;
    errs.push({ err: map(ours) - g[side].accuracy, matedMoves });
  }
  const summarise = (list) => {
    if (!list.length) return { n: 0, bias: 0, rmse: 0, over10: 0 };
    const bias = list.reduce((a, e) => a + e.err, 0) / list.length;
    const rmse = Math.sqrt(list.reduce((a, e) => a + e.err * e.err, 0) / list.length);
    return { n: list.length, bias, rmse, over10: list.filter((e) => Math.abs(e.err) > 10).length };
  };
  return { all: summarise(errs), mated: summarise(errs.filter((e) => e.matedMoves >= 3)) };
}

console.log('\ncapping moves made inside a forced mate against you (k=4, miss=25, mean):');
console.log('  map fitted on the general set; "mated set" = ' + matedSet.length + ' checkmate games, "3+ mated" = sides that made 3+ moves inside a forced mate');
console.log('  cap     r    residual  >10 off   held-out mapped   | mated set: bias  rmse  >10   | 3+ mated: n  bias  rmse');
for (const name of ['sane k=4 miss=25 c=0.0435, mean', 'matedCap 90 (k=4 miss=25), mean', 'matedCap 80 (k=4 miss=25), mean', 'matedCap 70 (k=4 miss=25), mean', 'matedCap 60 (k=4 miss=25), mean', 'matedCap 40 (k=4 miss=25), mean', 'matedCap 20 (k=4 miss=25), mean']) {
  const cand = CANDIDATES.find((x) => x.name === name);
  if (!cand) continue;
  const gen = scoreSet(cand, data.games).all;
  const h = held(cand);
  const m = scoreSet(cand, matedSet);
  const label = name.startsWith('matedCap') ? name.split(' ')[1] : 'none';
  console.log('  ' + label.padEnd(6) + cand.fit.r.toFixed(3).padStart(7) + cand.fit.residual.toFixed(1).padStart(9) + (gen.over10 + '/' + gen.n).padStart(9) +
    ('   ' + h.mw.toFixed(1) + ' / ' + h.mb.toFixed(1)).padEnd(20) + '|' +
    m.all.bias.toFixed(1).padStart(12) + m.all.rmse.toFixed(1).padStart(6) + (m.all.over10 + '/' + m.all.n).padStart(7) + '   |' +
    String(m.mated.n).padStart(9) + m.mated.bias.toFixed(1).padStart(6) + m.mated.rmse.toFixed(1).padStart(6));
}

// Which sides does the cap actually move, and in which direction relative to Chess.com?
{
  const base = CANDIDATES.find((x) => x.name === 'sane k=4 miss=25 c=0.0435, mean');
  const capped = CANDIDATES.find((x) => x.name === 'matedCap 60 (k=4 miss=25), mean');
  console.log('\nsides the cap (60) moves by more than 2 points (mapped):');
  console.log('  game                                   side   chess.com   none    cap60   mated moves');
  for (const g of data.games) for (const [color, side] of [['w', 'white'], ['b', 'black']]) {
    const a = gameAccuracy(g, color, base); const b = gameAccuracy(g, color, capped);
    if (a === null) continue;
    const ma = base.fit.slope * a + base.fit.intercept; const mb = capped.fit.slope * b + capped.fit.intercept;
    if (Math.abs(ma - mb) < 2) continue;
    const mated = g.moves.filter((m) => m.color === color && m.mateBefore !== null && m.mateBefore < 0).length;
    console.log('  ' + String(g.id || g.url || '').slice(-38).padEnd(40) + side.padEnd(7) + String(g[side].accuracy).padStart(8) +
      ma.toFixed(1).padStart(8) + mb.toFixed(1).padStart(8) + String(mated).padStart(8));
  }
}

{
  const c = CANDIDATES.find((x) => x.name === 'matedCap 80 (k=4 miss=25), mean');
  console.log('\nshipped formula (matedCap 80): slope ' + c.fit.slope.toFixed(4) + ' intercept ' + c.fit.intercept.toFixed(3));
}
