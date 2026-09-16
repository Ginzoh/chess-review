/**
 * Collect games that ended in checkmate after a long forced sequence, with
 * Chess.com's accuracies attached. The general calibration set has almost no
 * such games, so it cannot tell us how Chess.com scores the "best" moves a
 * player makes while already inside a forced mate. This set can.
 *
 *   node scripts/harvest-mated-games.mjs [count] [outFile]
 */

import fs from 'fs';
import https from 'https';

const TARGET = Number(process.argv[2] || 30);
const OUT = process.argv[3] || 'scripts/data/mated-games.json';
const UA = 'chess-review-local/1.0 (calibration)';

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      })
      .on('error', () => resolve(null));
  });
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const games = [];
const seen = new Set();
const queue = [];
for (const code of ['VA', 'IS', 'MT', 'LU', 'EE', 'CY']) {
  const pool = await get('https://api.chess.com/pub/country/' + code + '/players');
  if (pool && pool.players) queue.push(...shuffle(pool.players).slice(0, 80));
}
console.log('seed accounts: ' + queue.length);

while (games.length < TARGET && queue.length) {
  const username = queue.shift();
  const key = String(username).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const archives = await get('https://api.chess.com/pub/player/' + username + '/games/archives');
  if (!archives || !archives.archives || !archives.archives.length) continue;
  const month = await get(archives.archives[archives.archives.length - 1]);
  if (!month || !month.games) continue;
  let takenHere = 0;
  for (const game of month.games) {
    if (game.rules !== 'chess' || !game.accuracies || !game.rated) continue;
    if (game.time_class !== 'blitz' && game.time_class !== 'rapid') continue;
    const mated = game.white.result === 'checkmated' || game.black.result === 'checkmated';
    if (!mated) continue;
    const moves = (game.pgn.match(/\d+\.\s/g) || []).length;
    if (moves < 18 || moves > 60) continue;
    // Beginners let forced mates run for many moves; that is the regime we need.
    if (game.white.rating > 1500 || game.black.rating > 1500) continue;
    games.push({
      pgn: game.pgn,
      timeClass: game.time_class,
      white: { rating: game.white.rating, accuracy: game.accuracies.white },
      black: { rating: game.black.rating, accuracy: game.accuracies.black }
    });
    takenHere++;
    for (const side of ['white', 'black']) {
      const u = game[side].username;
      if (!seen.has(u.toLowerCase())) queue.push(u);
    }
    if (takenHere >= 2 || games.length >= TARGET) break;
  }
  process.stdout.write('  ' + games.length + '/' + TARGET + ' games\r');
}

fs.writeFileSync(OUT, JSON.stringify(games, null, 1));
console.log('\nwrote ' + games.length + ' games to ' + OUT);
