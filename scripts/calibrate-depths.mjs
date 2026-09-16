/**
 * Measure how our accuracy relates to Chess.com's at each analysis depth.
 *
 * Our accuracy is depth-dependent: a shallow search misses refutations, so more
 * moves look "best" and the score comes out high. The rating estimate is calibrated
 * against Chess.com's accuracy values, so we need the offset at every depth the UI
 * offers, otherwise "Fast" and "Deep" would report different ratings for one game.
 *
 * Caches a fixed game set so every depth sees exactly the same positions.
 *
 *   node scripts/calibrate-depths.mjs [games] [depths]
 *   node scripts/calibrate-depths.mjs 16 12,16,20
 */

import fs from 'fs';
import https from 'https';
import { CliEngine } from './cli-engine.mjs';
import { analyseGame } from '../public/js/analysis.js';

const WANTED = Number(process.argv[2] || 16);
const DEPTHS = (process.argv[3] || '12,16,20').split(',').map(Number);
const SET_FILE = 'scripts/data/calibration-games.json';
const OUT = 'scripts/data/depth-calibration.json';

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

/* ------------------------------------------------- the fixed game set -- */

async function buildGameSet() {
  if (fs.existsSync(SET_FILE)) {
    const cached = JSON.parse(fs.readFileSync(SET_FILE, 'utf8'));
    if (cached.length >= WANTED) return cached.slice(0, WANTED);
  }

  const seeds = [];
  for (const code of ['VA', 'IS', 'MT', 'LU', 'EE', 'CY']) {
    const pool = await get('https://api.chess.com/pub/country/' + code + '/players');
    if (pool && pool.players) {
      for (let i = 0; i < 40; i++) seeds.push(pool.players[Math.floor(Math.random() * pool.players.length)]);
    }
  }
  // A few strong accounts so the top of the range is represented too.
  seeds.splice(10, 0, 'hikaru', 'gothamchess', 'magnuscarlsen', 'fabianocaruana', 'danielnaroditsky');

  const picked = [];
  for (const player of seeds) {
    if (picked.length >= WANTED) break;
    const archives = await get('https://api.chess.com/pub/player/' + String(player).toLowerCase() + '/games/archives');
    if (!archives || !archives.archives || !archives.archives.length) continue;
    const month = await get(archives.archives[archives.archives.length - 1]);
    if (!month || !month.games) continue;

    const usable = month.games.filter((g) => {
      if (g.rules !== 'chess' || !g.accuracies || !g.pgn || g.time_class === 'daily') return false;
      const plies = (g.pgn.match(/\d+\./g) || []).length;
      return plies >= 20 && plies <= 40;
    });
    if (usable.length) {
      const g = usable[Math.floor(Math.random() * usable.length)];
      picked.push({
        pgn: g.pgn,
        timeClass: g.time_class,
        white: { rating: g.white.rating, accuracy: g.accuracies.white },
        black: { rating: g.black.rating, accuracy: g.accuracies.black }
      });
    }
  }

  fs.mkdirSync('scripts/data', { recursive: true });
  fs.writeFileSync(SET_FILE, JSON.stringify(picked, null, 1));
  return picked;
}

/* ----------------------------------------------------------------- run -- */

const games = await buildGameSet();
console.log('calibration set: ' + games.length + ' games');
console.log('ratings: ' + Math.min(...games.flatMap((g) => [g.white.rating, g.black.rating])) +
  ' to ' + Math.max(...games.flatMap((g) => [g.white.rating, g.black.rating])) + '\n');

const engine = new CliEngine();
await engine.boot();

const results = {};

for (const depth of DEPTHS) {
  const pairs = [];
  const started = Date.now();
  for (const [i, game] of games.entries()) {
    const analysis = await analyseGame(engine, game.pgn, { depth }, () => {});
    for (const side of ['white', 'black']) {
      const mine = analysis.stats[side === 'white' ? 'w' : 'b'].accuracy;
      if (mine === null) continue;
      pairs.push({ mine, theirs: game[side].accuracy, rating: game[side].rating, timeClass: game.timeClass });
    }
    process.stdout.write('  depth ' + depth + ': ' + (i + 1) + '/' + games.length + '\r');
  }

  const n = pairs.length;
  const diffs = pairs.map((p) => p.mine - p.theirs);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;

  const mx = pairs.reduce((a, p) => a + p.mine, 0) / n;
  const my = pairs.reduce((a, p) => a + p.theirs, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pairs) {
    num += (p.mine - mx) * (p.theirs - my);
    den += (p.mine - mx) ** 2;
  }
  const slope = num / den;
  const intercept = my - slope * mx;
  const sy = Math.sqrt(pairs.reduce((a, p) => a + (p.theirs - my) ** 2, 0) / n);
  const correlation = num / n / (Math.sqrt(den / n) * sy);

  results[depth] = {
    n,
    meanDiff: Number(meanDiff.toFixed(2)),
    slope: Number(slope.toFixed(4)),
    intercept: Number(intercept.toFixed(3)),
    correlation: Number(correlation.toFixed(4)),
    seconds: Math.round((Date.now() - started) / 1000),
    pairs
  };

  let ss = 0;
  for (const p of pairs) ss += (p.theirs - (slope * p.mine + intercept)) ** 2;
  results[depth].residualRmse = Number(Math.sqrt(ss / n).toFixed(2));

  console.log(
    '  depth ' + String(depth).padEnd(3) +
    ' n=' + n +
    '  ours-theirs=' + meanDiff.toFixed(2).padStart(6) +
    '  theirs=' + slope.toFixed(3) + '*ours' + (intercept >= 0 ? '+' : '') + intercept.toFixed(2) +
    '  r=' + correlation.toFixed(3) +
    '  residual rmse ' + results[depth].residualRmse +
    '  (' + results[depth].seconds + 's)'
  );
}

engine.quit();
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

console.log('\nDoes the gap close as the search deepens?');
for (const d of DEPTHS) console.log('  depth ' + String(d).padStart(2) + ': ' + results[d].meanDiff.toFixed(2) + ' accuracy points above Chess.com');
console.log('\nwritten to ' + OUT);
