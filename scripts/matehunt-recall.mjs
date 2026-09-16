/**
 * Recall of the mate hunt against a deep oracle.
 *
 * For the winner's final positions in real checkmate games, a slow deep search
 * decides whether a forced mate really exists. Then each candidate hunt setting
 * (extra depth + time cap) is scored on how many of those true mates it recovers,
 * and what it costs. This is what chooses MATE_HUNT_EXTRA_DEPTH / MATE_HUNT_MS.
 *
 *   node scripts/matehunt-recall.mjs [games]
 */

import https from 'https';
import { CliEngine } from './cli-engine.mjs';
import { Chess } from '../public/js/chessutils.js';

const WANTED = Number(process.argv[2] || 5);
const BASE_DEPTH = 12;
const ORACLE = { depth: 28, movetime: 15000 };
const CANDIDATES = [
  { label: 'd+8, 1.2s', depth: BASE_DEPTH + 8, movetime: 1200 },
  { label: 'd+8, 2.5s', depth: BASE_DEPTH + 8, movetime: 2500 },
  { label: 'd+10, 2.5s', depth: BASE_DEPTH + 10, movetime: 2500 },
  { label: 'd+10, 4s', depth: BASE_DEPTH + 10, movetime: 4000 }
];

function get(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'chess-review-local/1.0 (calibration)' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(d) : null); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const pool = await get('https://api.chess.com/pub/country/IS/players');
const seeds = ['gothamchess'];
if (pool && pool.players) for (let i = 0; i < 40; i++) seeds.push(pool.players[Math.floor(Math.random() * pool.players.length)]);

const games = [];
for (const player of seeds) {
  if (games.length >= WANTED) break;
  const archives = await get('https://api.chess.com/pub/player/' + String(player).toLowerCase() + '/games/archives');
  if (!archives || !archives.archives || !archives.archives.length) continue;
  const month = await get(archives.archives[archives.archives.length - 1]);
  if (!month || !month.games) continue;
  const mates = month.games.filter((g) => g.rules === 'chess' && g.pgn && (g.white.result === 'checkmated' || g.black.result === 'checkmated'));
  for (const g of mates.slice(0, 2)) {
    games.push({ pgn: g.pgn, winner: g.white.result === 'checkmated' ? 'b' : 'w' });
    if (games.length >= WANTED) break;
  }
}

// The winner's positions in the last 8 moves, minus the trivial final one.
const positions = [];
for (const game of games) {
  const c = new Chess();
  c.loadPgn(game.pgn);
  const h = c.history({ verbose: true });
  const slice = h.slice(Math.max(0, h.length - 16), h.length - 1).filter((m) => m.color === game.winner);
  for (const m of slice) positions.push(m.before);
}
console.log(games.length + ' games, ' + positions.length + ' positions\n');

const engine = new CliEngine();
await engine.boot();

// Shallow pass first: the hunt only ever runs where this shows a clear win but no mate.
const shallow = [];
for (const fen of positions) shallow.push((await engine.analyse(fen, { depth: BASE_DEPTH, multipv: 1 })).lines[0]);

console.log('oracle (depth ' + ORACLE.depth + ', ' + ORACLE.movetime / 1000 + 's cap) ...');
const oracle = [];
let t0 = Date.now();
for (const [i, fen] of positions.entries()) {
  oracle.push((await engine.analyse(fen, Object.assign({ multipv: 1 }, ORACLE))).lines[0]);
  process.stdout.write('  ' + (i + 1) + '/' + positions.length + '\r');
}
console.log('  done in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's\n');

const isMate = (l) => !!(l && l.mate !== null && l.mate !== undefined && l.mate > 0);
const trueMates = positions.map((_, i) => isMate(oracle[i]));
const shallowSaw = positions.map((_, i) => isMate(shallow[i]));
const eligible = positions.map((_, i) => !shallowSaw[i] && shallow[i] && (shallow[i].cp || 0) >= 500);

const total = trueMates.filter(Boolean).length;
const alreadySeen = trueMates.filter((t, i) => t && shallowSaw[i]).length;
const hidden = trueMates.filter((t, i) => t && !shallowSaw[i]).length;
const hiddenEligible = trueMates.filter((t, i) => t && !shallowSaw[i] && eligible[i]).length;

console.log('forced mates per oracle:        ' + total + ' of ' + positions.length + ' positions');
console.log('  seen by the shallow pass:     ' + alreadySeen);
console.log('  hidden from the shallow pass: ' + hidden + '  (of which ' + hiddenEligible + ' sit in positions the hunt would look at, eval >= +5)');
console.log();

console.log('candidate        recovers hidden mates   time per hunted position');
for (const cand of CANDIDATES) {
  let recovered = 0;
  let hunted = 0;
  t0 = Date.now();
  for (const [i, fen] of positions.entries()) {
    if (!eligible[i]) continue;
    hunted++;
    const r = await engine.analyse(fen, { depth: cand.depth, movetime: cand.movetime, multipv: 1 });
    if (isMate(r.lines[0]) && trueMates[i]) recovered++;
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(
    '  ' + cand.label.padEnd(14) + String(recovered + '/' + hiddenEligible).padStart(10) +
    (hiddenEligible ? ('  (' + Math.round((100 * recovered) / hiddenEligible) + '%)').padEnd(9) : '         ') +
    (hunted ? (secs / hunted).toFixed(1) + 's' : '-').padStart(14) + '   hunted ' + hunted
  );
}
engine.quit();
