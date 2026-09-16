/**
 * Runs the coach over every move of the fixture games and checks the output holds
 * up: no placeholder text, a concept named for every error, advice attached, and
 * variations that are actually legal.
 *
 *   node scripts/coachtest.mjs
 */

import { CliEngine } from './cli-engine.mjs';
import { analyseGame } from '../public/js/analysis.js';
import { coachMove } from '../public/js/coach.js';
import { CONCEPTS } from '../public/js/concepts.js';
import { Chess } from '../public/js/chessutils.js';

const DEPTH = Number(process.env.DEPTH || 12);

const GAMES = [
  {
    name: 'Scholar\'s mate — a blunder into mate in one',
    pgn:
      '[Event "S"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[TimeControl "600"]\n\n' +
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
    name: 'Legal trap — a queen sacrifice for mate',
    pgn:
      '[Event "L"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[TimeControl "600"]\n\n' +
      '1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5# 1-0'
  },
  {
    name: 'Opera Game — sacrifices into mate',
    pgn:
      '[Event "O"]\n[White "Morphy"]\n[Black "Duke"]\n[Result "1-0"]\n[TimeControl "-"]\n\n' +
      '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 ' +
      '8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 ' +
      '14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0'
  },
  {
    name: 'Back-rank finish',
    pgn:
      '[Event "BR"]\n[White "A"]\n[Black "B"]\n[Result "0-1"]\n[TimeControl "600"]\n\n' +
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O ' +
      '8. c3 d6 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 cxd4 13. cxd4 Nc6 14. Nb3 a5 0-1'
  }
];

let failures = 0;
const check = (label, ok, extra) => {
  if (!ok) {
    console.log('  FAIL ' + label + (extra ? ' — ' + extra : ''));
    failures++;
  }
};

const engine = new CliEngine();
await engine.boot();

const conceptCounts = new Map();
let coached = 0;

for (const game of GAMES) {
  console.log('\n' + game.name);
  const analysis = await analyseGame(engine, game.pgn, { depth: DEPTH }, () => {});

  for (const move of analysis.moves) {
    const out = coachMove(move, analysis);
    coached++;
    conceptCounts.set(out.concept, (conceptCounts.get(out.concept) || 0) + 1);

    const all = out.headline + ' ' + out.sections.map((s) => s.title + ' ' + s.body + ' ' + (s.variation || '')).join(' ');
    const where = 'ply ' + move.ply + ' (' + move.san + ', ' + move.label.text + ')';

    check(where + ': has a headline', !!out.headline && out.headline.length > 15);
    // Every move gets a real breakdown, not just a single line - including the good
    // ones, which are half the game. Forced moves are the exception: with one legal
    // move there is genuinely nothing to coach.
    const minSections = move.label.key === 'forced' ? 1 : 2;
    check(where + ': has a real breakdown', out.sections.length >= minSections,
      JSON.stringify(out.sections.map((x) => x.title)));
    check(where + ': no placeholders', !/undefined|NaN|\[object|null/.test(all), all.slice(0, 160));
    check(where + ': concept is a known one', !!CONCEPTS[out.concept], out.concept);
    check(where + ': every section has a body', out.sections.every((s) => s.body && s.body.length > 10));

    // A mistake must always come with a concept section and something to work on.
    const isError = ['inaccuracy', 'mistake', 'blunder', 'missedWin'].indexOf(move.label.key) !== -1;
    if (isError) {
      check(where + ': names the idea behind the error',
        out.sections.some((s) => s.title.startsWith('The idea behind it')));
      check(where + ': gives something to work on',
        out.sections.some((s) => s.title === 'Work on this' && s.body.length > 40));
      check(where + ': says what to play instead',
        out.sections.some((s) => s.title === 'What to play instead'));
    }

    // Every quoted variation has to be legal from the position it claims to start in.
    for (const section of out.sections) {
      if (!section.variation) continue;
      // The section says which position its line starts from, so there is nothing to guess.
      const start = section.variationFrom;
      check(where + ': variation declares where it starts', !!start);
      if (!start) continue;
      const sans = section.variation.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/).filter(Boolean);
      const board = new Chess(start);
      let legal = true;
      for (const san of sans) {
        try {
          if (!board.move(san)) legal = false;
        } catch (e) {
          legal = false;
        }
        if (!legal) break;
      }
      check(where + ': variation "' + section.variation + '" is legal', legal);
    }
  }

  // Show one worked example per game so the output can be read, not just asserted.
  const worst = analysis.moves.slice().sort((a, b) => b.winLoss - a.winLoss)[0];
  if (worst && worst.winLoss > 3) {
    const out = coachMove(worst, analysis);
    console.log('  ' + out.headline);
    for (const s of out.sections) {
      console.log('    ' + s.title.toUpperCase());
      console.log('      ' + s.body);
      if (s.variation) console.log('      line: ' + s.variation);
    }
  }
}

engine.quit();

console.log('\ncoached ' + coached + ' moves');
console.log('concepts used: ' + Array.from(conceptCounts.entries()).map(([k, v]) => k + '×' + v).join(', '));
console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll coach checks passed.');
process.exit(failures ? 1 : 0);
