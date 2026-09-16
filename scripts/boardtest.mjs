/**
 * Unit tests for the move-animation diff: given two positions, work out which
 * pieces slid where, what was captured, and what reappears when stepping back.
 *
 *   node scripts/boardtest.mjs
 */

import { piecesFromFen, diffPositions } from '../public/js/board.js';

const CASES = [
  {
    name: 'quiet move (Nf3)',
    before: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b',
    after: 'rnbqkbnr/pppppppp/8/8/4P3/5N2/PPPP1PPP/RNBQKB1R b',
    moves: ['N g1>f3'],
    fadeOut: [],
    fadeIn: []
  },
  {
    name: 'capture (Nxe5)',
    before: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w',
    after: 'r1bqkbnr/pppp1ppp/2n5/4N3/4P3/8/PPPP1PPP/RNBQKB1R b',
    moves: ['N f3>e5'],
    fadeOut: ['p@e5'],
    fadeIn: []
  },
  {
    name: 'stepping back over a capture puts the piece back',
    before: 'r1bqkbnr/pppp1ppp/2n5/4N3/4P3/8/PPPP1PPP/RNBQKB1R b',
    after: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w',
    moves: ['N e5>f3'],
    fadeOut: [],
    fadeIn: ['p@e5']
  },
  {
    name: 'castling moves king and rook',
    before: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w',
    after: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 b',
    moves: ['K e1>g1', 'R h1>f1'],
    fadeOut: [],
    fadeIn: []
  },
  {
    name: 'queenside castling',
    before: 'r3kbnr/pppqpppp/2npb3/8/8/2NPB3/PPPQPPPP/R3KBNR w',
    after: 'r3kbnr/pppqpppp/2npb3/8/8/2NPB3/PPPQPPPP/2KR1BNR b',
    moves: ['K e1>c1', 'R a1>d1'],
    fadeOut: [],
    fadeIn: []
  },
  {
    name: 'en passant removes a pawn off the landing square',
    before: 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w',
    after: 'rnbqkbnr/ppp1pppp/3P4/8/8/8/PPPP1PPP/RNBQKBNR b',
    moves: ['P e5>d6'],
    fadeOut: ['p@d5'],
    fadeIn: []
  },
  {
    name: 'promotion slides the new queen in',
    before: '8/4P3/8/8/8/8/8/K6k w',
    after: '4Q3/8/8/8/8/8/8/K6k b',
    moves: ['Q e7>e8'],
    fadeOut: [],
    fadeIn: []
  },
  {
    name: 'promotion with capture',
    before: '4r3/3P4/8/8/8/8/8/K6k w',
    after: '4Q3/8/8/8/8/8/8/K6k b',
    moves: ['Q d7>e8'],
    fadeOut: ['r@e8'],
    fadeIn: []
  },
  {
    name: 'the nearer of two identical pieces is the one that moved',
    before: '8/8/8/8/8/8/1N4N1/K6k w',
    after: '8/8/8/8/8/5N2/1N6/K6k b',
    moves: ['N g2>f3'],
    fadeOut: [],
    fadeIn: []
  },
  {
    name: 'identical positions produce no animation',
    before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w',
    after: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w',
    moves: [],
    fadeOut: [],
    fadeIn: []
  }
];

let failures = 0;

function compare(label, actual, expected) {
  const a = actual.slice().sort().join(' | ');
  const b = expected.slice().sort().join(' | ');
  if (a === b) return true;
  console.log('  FAIL ' + label + '\n        expected: ' + (b || '(none)') + '\n        actual:   ' + (a || '(none)'));
  failures++;
  return false;
}

for (const c of CASES) {
  const diff = diffPositions(piecesFromFen(c.before), piecesFromFen(c.after));
  const moves = diff.moves.map((m) => m.piece + ' ' + m.from + '>' + m.to);
  const fadeOut = diff.fadeOut.map((f) => f.piece + '@' + f.square);
  const fadeIn = diff.fadeIn.map((f) => f.piece + '@' + f.square);

  const ok =
    compare(c.name + ' [moves]', moves, c.moves) &
    compare(c.name + ' [fadeOut]', fadeOut, c.fadeOut) &
    compare(c.name + ' [fadeIn]', fadeIn, c.fadeIn);

  if (ok) console.log('  ok   ' + c.name + (moves.length ? '  →  ' + moves.join(', ') : ''));
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll board animation checks passed.');
process.exit(failures ? 1 : 0);
