/**
 * Harvest (rating, accuracy) pairs from real Chess.com games.
 *
 * Chess.com publishes its own accuracy score and both players' ratings for most
 * games, which gives us thousands of labelled samples for free - no engine time.
 * We use it to learn the shape of the accuracy -> rating relationship, which is
 * what the "played like ~1650" estimate is built on.
 *
 *   node scripts/harvest-ratings.mjs [targetSamples] [outFile]
 */

import fs from 'fs';
import https from 'https';

const TARGET = Number(process.argv[2] || 6000);
const OUT = process.argv[3] || 'scripts/data/rating-samples.json';
// --natural: no per-band caps and no leaderboard seeds, so the sample reflects the
// real population instead of a flat one. The flat version is right for learning the
// *shape* of the accuracy-rating curve; the natural one is right for estimating
// E[rating | accuracy], which depends on how many players sit in each band.
const NATURAL = process.argv.includes('--natural');

const UA = 'chess-review-local/1.0 (calibration)';

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

/** Keep the bands balanced so the fit is not dominated by the crowded middle. */
const BAND = 100;
const PER_BAND = Math.ceil(TARGET / 26);
const bands = new Map();

function bandOf(rating) {
  return Math.floor(rating / BAND) * BAND;
}

function wanted(rating) {
  if (rating < 100 || rating > 3400) return false;
  if (NATURAL) return true;
  return (bands.get(bandOf(rating)) || 0) < PER_BAND;
}

const samples = [];

function record(rating, accuracy, meta) {
  if (!wanted(rating)) return false;
  const b = bandOf(rating);
  bands.set(b, (bands.get(b) || 0) + 1);
  samples.push({ rating, accuracy: Number(accuracy.toFixed(2)), ...meta });
  return true;
}

async function harvestPlayer(username, seen) {
  const archives = await get('https://api.chess.com/pub/player/' + username + '/games/archives');
  if (!archives || !archives.archives || !archives.archives.length) return [];

  const opponents = [];
  // Two months is plenty per player, and keeps one account from skewing the set.
  let takenHere = 0;
  for (const url of archives.archives.slice(-2)) {
    const month = await get(url);
    if (!month || !month.games) continue;

    for (const game of month.games) {
      if (game.rules !== 'chess' || !game.accuracies || !game.rated) continue;
      if (game.time_class === 'daily') continue; // correspondence play is a different skill
      const plies = (game.pgn.match(/\d+\./g) || []).length;
      if (plies < 15) continue; // too short to say anything about strength

      for (const side of ['white', 'black']) {
        const player = game[side];
        const acc = game.accuracies[side];
        if (!player.rating || typeof acc !== 'number') continue;
        if (record(player.rating, acc, { timeClass: game.time_class, plies })) takenHere++;
        if (!seen.has(player.username.toLowerCase())) opponents.push(player.username);
      }
      if (samples.length >= TARGET) return opponents;
      if (NATURAL && takenHere >= 24) return opponents;
    }
  }
  return opponents;
}

/* Seed from a random-ish public pool plus the leaderboards, so the sample spans
   beginners through grandmasters rather than clustering in the middle. */
async function seedUsernames() {
  const seeds = [];
  for (const code of ['VA', 'IS', 'MT', 'LU', 'EE', 'CY', 'FO', 'GL', 'SM', 'LI']) {
    const pool = await get('https://api.chess.com/pub/country/' + code + '/players');
    if (pool && pool.players) seeds.push(...shuffle(pool.players).slice(0, NATURAL ? 200 : 120));
  }
  const boards = NATURAL ? null : await get('https://api.chess.com/pub/leaderboards');
  if (boards) {
    for (const key of ['live_blitz', 'live_rapid', 'live_bullet']) {
      for (const entry of boards[key] || []) seeds.push(entry.username);
    }
  }
  return shuffle(seeds);
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const queue = await seedUsernames();
const seen = new Set();
console.log('seed accounts: ' + queue.length);

let processed = 0;
while (queue.length && samples.length < TARGET) {
  const username = queue.shift();
  const key = String(username).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  const opponents = await harvestPlayer(key, seen);
  processed++;
  // Following opponents walks outward into rating bands the seed pool missed.
  for (const o of opponents.slice(0, 6)) if (!seen.has(o.toLowerCase())) queue.push(o);

  if (processed % 10 === 0) {
    // Save as we go, so a long harvest is never lost to an interrupted run.
    fs.mkdirSync('scripts/data', { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(samples));
    process.stdout.write('  accounts ' + processed + ' · samples ' + samples.length + '/' + TARGET + '\r');
  }
}

fs.mkdirSync('scripts/data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(samples));

console.log('\n\nsamples: ' + samples.length + ' from ' + processed + ' accounts');
console.log('\nrating band coverage:');
for (const b of Array.from(bands.keys()).sort((a, b2) => a - b2)) {
  console.log('  ' + String(b).padStart(4) + '-' + String(b + BAND - 1) + '  ' + '#'.repeat(Math.ceil(bands.get(b) / 8)) + ' ' + bands.get(b));
}
console.log('\nwritten to ' + OUT);
