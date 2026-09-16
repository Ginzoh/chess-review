/**
 * Does our accuracy number agree with the one Chess.com publishes?
 *
 * The rating estimate is calibrated on Chess.com's accuracy values (there are
 * thousands of them, free). That calibration only transfers to our own metric if
 * the two agree, so measure it rather than assume it.
 *
 *   node scripts/compare-accuracy.mjs [games] [out.json]
 */

import fs from 'fs';
import https from 'https';
import { CliEngine } from './cli-engine.mjs';
import { analyseGame } from '../public/js/analysis.js';

const WANTED = Number(process.argv[2] || 24);
const OUT = process.argv[3] || 'scripts/data/accuracy-comparison.json';
const DEPTH = Number(process.env.DEPTH || 12);

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'chess-review-local/1.0 (calibration)' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(data) : null);
          } catch (e) {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

/**
 * Spread the sample across the whole rating range. Elite accounts alone would only
 * tell us the two metrics agree at the top, which is not where most games are.
 */
async function seedPlayers() {
  const elite = ['hikaru', 'magnuscarlsen', 'fabianocaruana', 'lachesisq', 'gothamchess'];
  const ordinary = [];
  for (const code of ['VA', 'IS', 'MT']) {
    const pool = await get('https://api.chess.com/pub/country/' + code + '/players');
    if (pool && pool.players) {
      for (let i = 0; i < 25 && i < pool.players.length; i++) {
        ordinary.push(pool.players[Math.floor(Math.random() * pool.players.length)]);
      }
    }
  }
  // Interleave so a short run still covers both ends.
  const mixed = [];
  for (let i = 0; i < Math.max(elite.length, ordinary.length); i++) {
    if (ordinary[i]) mixed.push(ordinary[i]);
    if (elite[i]) mixed.push(elite[i]);
  }
  return mixed;
}

const SEED_PLAYERS = await seedPlayers();

const games = [];
for (const player of SEED_PLAYERS) {
  if (games.length >= WANTED) break;
  const archives = await get('https://api.chess.com/pub/player/' + player + '/games/archives');
  if (!archives || !archives.archives || !archives.archives.length) continue;
  const month = await get(archives.archives[archives.archives.length - 1]);
  if (!month || !month.games) continue;

  // Opponents of these accounts cover a wide band, and short games keep it quick.
  const usable = month.games.filter((g) => {
    if (g.rules !== 'chess' || !g.accuracies || !g.pgn) return false;
    const plies = (g.pgn.match(/\d+\./g) || []).length;
    return plies >= 20 && plies <= 45;
  });
  for (const g of usable.slice(0, 3)) {
    games.push(g);
    if (games.length >= WANTED) break;
  }
}

console.log('comparing ' + games.length + ' games at depth ' + DEPTH + '\n');

const engine = new CliEngine();
await engine.boot();

const rows = [];
for (const [i, game] of games.entries()) {
  const analysis = await analyseGame(engine, game.pgn, { depth: DEPTH }, () => {});
  for (const side of ['white', 'black']) {
    const mine = analysis.stats[side === 'white' ? 'w' : 'b'].accuracy;
    const theirs = game.accuracies[side];
    if (mine === null || typeof theirs !== 'number') continue;
    rows.push({
      rating: game[side].rating,
      mine: Number(mine.toFixed(2)),
      theirs: Number(theirs.toFixed(2)),
      timeClass: game.time_class
    });
  }
  process.stdout.write('  ' + (i + 1) + '/' + games.length + '\r');
}
engine.quit();

fs.mkdirSync('scripts/data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));

/* ---- how close are they? ---- */

const n = rows.length;
const diffs = rows.map((r) => r.mine - r.theirs);
const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
const absDiff = diffs.map(Math.abs).reduce((a, b) => a + b, 0) / n;
const rmse = Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / n);

// Least-squares mine -> theirs, so any systematic offset can be corrected.
const mx = rows.reduce((a, r) => a + r.mine, 0) / n;
const my = rows.reduce((a, r) => a + r.theirs, 0) / n;
let num = 0;
let den = 0;
for (const r of rows) {
  num += (r.mine - mx) * (r.theirs - my);
  den += (r.mine - mx) * (r.mine - mx);
}
const slope = num / den;
const intercept = my - slope * mx;

const sy = Math.sqrt(rows.reduce((a, r) => a + (r.theirs - my) ** 2, 0) / n);
const sx = Math.sqrt(den / n);
const correlation = num / n / (sx * sy);

console.log('\n\npairs: ' + n);
console.log('mean(ours - chess.com): ' + meanDiff.toFixed(2) + ' accuracy points');
console.log('mean |difference|:      ' + absDiff.toFixed(2));
console.log('rmse:                   ' + rmse.toFixed(2));
console.log('correlation:            ' + correlation.toFixed(4));
console.log('fit  theirs = ' + slope.toFixed(4) + ' * ours + ' + intercept.toFixed(3));
console.log('\nwritten to ' + OUT);
