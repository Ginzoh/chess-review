/**
 * Does our engine, at each depth preset, actually see the forced mates that exist?
 *
 * Takes real games that ended in checkmate, looks at the positions in the last few
 * moves (where a forced mate is very likely on the board), and counts how often the
 * search reports a mate score. If the rate is low, "missed win" can never fire
 * because the engine never knew there was a win to miss.
 *
 *   node scripts/mate-detection.mjs [games] [depths]
 */

import https from 'https';
import { CliEngine } from './cli-engine.mjs';
import { Chess } from '../public/js/chessutils.js';

const WANTED = Number(process.argv[2] || 12);
const DEPTHS = (process.argv[3] || '12,16,20').split(',').map(Number);
const LOOKBACK_PLIES = 12; // examine the winner's positions in the last 6 moves

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': 'chess-review-local/1.0 (calibration)' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(d) : null);
          } catch (e) {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

// Mixed strengths: mates in strong games tend to be found late and be short;
// mates in weaker games are often available for many moves.
const seeds = ['hikaru', 'gothamchess', 'annacramling'];
const pool = await get('https://api.chess.com/pub/country/IS/players');
if (pool && pool.players) for (let i = 0; i < 40; i++) seeds.push(pool.players[Math.floor(Math.random() * pool.players.length)]);

const games = [];
for (const player of seeds) {
  if (games.length >= WANTED) break;
  const archives = await get('https://api.chess.com/pub/player/' + String(player).toLowerCase() + '/games/archives');
  if (!archives || !archives.archives || !archives.archives.length) continue;
  const month = await get(archives.archives[archives.archives.length - 1]);
  if (!month || !month.games) continue;
  const mates = month.games.filter(
    (g) => g.rules === 'chess' && g.pgn && (g.white.result === 'checkmated' || g.black.result === 'checkmated')
  );
  for (const g of mates.slice(0, 2)) {
    games.push({ pgn: g.pgn, winner: g.white.result === 'checkmated' ? 'b' : 'w', rating: Math.max(g.white.rating, g.black.rating) });
    if (games.length >= WANTED) break;
  }
}
console.log('checkmate games: ' + games.length);

const engine = new CliEngine();
await engine.boot();

const tally = {};
for (const d of DEPTHS) tally[d] = { positions: 0, mateSeen: 0, seconds: 0 };

for (const [gi, game] of games.entries()) {
  const chess = new Chess();
  chess.loadPgn(game.pgn);
  const history = chess.history({ verbose: true });
  const start = Math.max(0, history.length - LOOKBACK_PLIES);
  // Only the winner's positions - those are the ones where a forced mate should exist.
  const positions = history.slice(start).filter((m) => m.color === game.winner).map((m) => m.before);

  for (const depth of DEPTHS) {
    const t0 = Date.now();
    for (const fen of positions) {
      const result = await engine.analyse(fen, { depth, multipv: 1 });
      const line = result.lines[0];
      tally[depth].positions++;
      if (line && line.mate !== null && line.mate > 0) tally[depth].mateSeen++;
    }
    tally[depth].seconds += (Date.now() - t0) / 1000;
  }
  process.stdout.write('  game ' + (gi + 1) + '/' + games.length + '\r');
}
engine.quit();

console.log('\n\nwinner\'s positions in the last ' + LOOKBACK_PLIES / 2 + ' moves of games that ended in mate:\n');
console.log('  depth  positions  mate seen   rate    time');
for (const d of DEPTHS) {
  const t = tally[d];
  console.log(
    '  ' + String(d).padStart(5) + String(t.positions).padStart(11) + String(t.mateSeen).padStart(11) +
    (Math.round((t.mateSeen / t.positions) * 100) + '%').padStart(7) + (t.seconds.toFixed(0) + 's').padStart(8)
  );
}
console.log('\nNot every one of these positions has a forced mate, so 100% is not the target -');
console.log('what matters is how much the rate climbs with depth. A big climb means the shallow');
console.log('presets are blind to wins that are really there.');
