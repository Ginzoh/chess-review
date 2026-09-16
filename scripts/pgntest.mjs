/**
 * Runs the review pipeline over fixed PGNs chosen to hit the paths a clean
 * grandmaster game never reaches: sacrifices, forced mates, hung pieces.
 *
 *   node scripts/pgntest.mjs
 */

import { CliEngine } from './cli-engine.mjs';
import { analyseGame } from '../public/js/analysis.js';
import { buildReview, explainMove, formatCp } from '../public/js/insights.js';

const GAMES = [
  {
    name: 'Opera Game (Morphy) — sacrifices into mate',
    white: 'Morphy',
    black: 'Duke/Count',
    pgn:
      '[Event "Opera Game"]\n[White "Morphy"]\n[Black "Duke and Count"]\n[Result "1-0"]\n[TimeControl "-"]\n\n' +
      '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 ' +
      '8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 ' +
      '14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0'
  },
  {
    name: "Scholar's mate — an outright blunder allowing mate in one",
    white: 'Attacker',
    black: 'Victim',
    pgn:
      '[Event "Scholars"]\n[White "Attacker"]\n[Black "Victim"]\n[Result "1-0"]\n[TimeControl "600"]\n\n' +
      '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0'
  },
  {
    name: 'Missed mate in two (Ra8+ Bd8 Rxd8#), still winning afterwards',
    white: 'A',
    black: 'B',
    pgn:
      '[Event "Miss"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[TimeControl "600"]\n' +
      '[SetUp "1"]\n[FEN "6k1/5ppp/1b6/8/8/8/4QPPP/R5K1 w - - 0 1"]\n\n' +
      '1. Qe4 h6 2. Qb7 Bd4 3. Ra8+ Kh7 4. Qf3 1-0'
  },
  {
    name: 'Legal trap — a queen sacrifice for a forced mate',
    white: 'Legal',
    black: 'Saint Brie',
    pgn:
      '[Event "Legal"]\n[White "Legal"]\n[Black "Saint Brie"]\n[Result "1-0"]\n[TimeControl "600"]\n\n' +
      '1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0'
  },
  {
    name: 'Hung queen — free material left on the board',
    white: 'White',
    black: 'Black',
    pgn:
      '[Event "Hang"]\n[White "White"]\n[Black "Black"]\n[Result "0-1"]\n[TimeControl "300+2"]\n\n' +
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. Bg5 h6 6. Bh4 g5 7. Bg3 Qe7 ' +
      '8. Nc3 d6 9. Nd5 Nxd5 10. Bxd5 Bg4 11. c3 O-O-O 12. b4 Bb6 13. a4 a5 14. b5 Nb8 0-1'
  }
];

const depth = Number(process.env.DEPTH || 12);
const engine = new CliEngine();
await engine.boot();

let failures = 0;

for (const game of GAMES) {
  console.log('\n' + '='.repeat(76));
  console.log(game.name);
  console.log('='.repeat(76));

  const analysis = await analyseGame(engine, game.pgn, { depth }, () => {});
  const result = game.pgn.match(/\[Result "([^"]+)"\]/)[1];

  const meta = {
    white: { username: game.white, rating: null },
    black: { username: game.black, rating: null },
    result,
    termination: result === '1/2-1/2' ? 'a draw' : 'checkmate',
    opening: null,
    openingUrl: null,
    timeClass: 'blitz'
  };

  for (const color of ['w', 'b']) {
    const review = buildReview(analysis, color, meta);
    const all = [review.headline]
      .concat(review.strengths.map((s) => s.title + ' ' + s.detail))
      .concat(review.improvements.map((s) => s.title + ' ' + s.detail))
      .concat(review.keyMoments.map((s) => s.title + ' ' + s.detail))
      .join('\n');
    if (/undefined|NaN|\[object/.test(all)) {
      failures++;
      console.log('!! broken text for ' + color + ':\n' + all);
    }
  }

  console.log('\nMOVES');
  for (const m of analysis.moves) {
    // Printed from White's side, as the app shows it everywhere.
    const before = formatCp(m.color === 'w' ? m.evalBeforeCp : -m.evalBeforeCp);
    const after = formatCp(m.color === 'w' ? m.evalAfterCp : -m.evalAfterCp);
    const text = explainMove(m).text;
    console.log(
      '  ' + String(m.moveNumber + (m.color === 'w' ? '.' : '...')).padStart(6) + ' ' + m.san.padEnd(7) +
      m.label.text.padEnd(12) + (before + ' -> ' + after).padEnd(20) + text
    );
    // The note must quote the same figure the move list shows - never the mover's-side sign.
    const quoted = text.match(/Evaluation: (\S+) → (\S+)\./);
    if (quoted && (quoted[1] !== before || quoted[2] !== after)) {
      failures++;
      console.log('  !! note quotes ' + quoted[1] + ' → ' + quoted[2] + ' but the move list shows ' + before + ' -> ' + after);
    }
  }

  if (game.name.startsWith('Missed mate')) {
    const miss = analysis.moves.find((m) => m.san === 'Qe4');
    const ok = !!miss && miss.label.key === 'missedWin' && miss.missedWin && miss.missedWin.kind === 'mate';
    console.log('\n  1. Qe4 labelled: ' + (miss ? miss.label.text : '?') + (ok ? '  (missed mate in ' + miss.missedWin.mateIn + ')' : ''));
    if (!ok) { failures++; console.log('  !! expected 1. Qe4 to be a Missed win (mate)'); }
    const white = analysis.stats.w;
    console.log('  White accuracy with the miss counted: ' + white.accuracy.toFixed(1) + ' (raw ' + white.rawAccuracy.toFixed(1) + ')');
  }

  const loser = result === '1-0' ? 'b' : 'w';
  const review = buildReview(analysis, loser, meta);
  console.log('\nREVIEW for the ' + (loser === 'w' ? 'White' : 'Black') + ' player:');
  console.log('  ' + review.headline);
  console.log('  WELL:');
  for (const s of review.strengths) console.log('    • ' + s.title);
  console.log('  WORK ON:');
  for (const s of review.improvements) console.log('    • ' + s.title + '\n      ' + s.detail);
}

engine.quit();
console.log(failures ? '\n!! ' + failures + ' text failures' : '\nText checks passed.');
process.exit(failures ? 1 : 0);
