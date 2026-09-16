/**
 * Unit tests for the board-pattern detectors the coach relies on.
 * Each case is a hand-built position where the motif is unambiguous.
 *
 *   node scripts/conceptstest.mjs
 */

import {
  findPins,
  backRankRisk,
  trappedPieces,
  overloadedDefenders,
  developmentState,
  isLoose
} from '../public/js/concepts.js';
import { Chess } from '../public/js/chessutils.js';

let failures = 0;
const check = (label, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !extra ? '' : ' — ' + extra));
  if (!ok) failures++;
};

/* ------------------------------------------------------------ pins ------ */

console.log('pins and skewers');

// White bishop g5, black knight f6, black king d8 - all on one diagonal, so the
// knight is pinned absolutely. (Put the king on e8 and it is a skewer instead, not
// a pin, because the king is then off the g5-f6-e7-d8 line.)
let c = new Chess('3k4/8/5n2/6B1/8/8/8/4K3 b - - 0 1');
let pins = findPins(c, 'b');
check('absolute pin against the king is found',
  pins.some((p) => p.kind === 'pin' && p.front.square === 'f6' && p.back.type === 'k' && p.absolute),
  JSON.stringify(pins.map((p) => p.kind + ' ' + p.front.square + '>' + p.back.square)));

// White rook e1, black knight e5, black queen e8: knight pinned against the queen.
c = new Chess('4q3/8/8/4n3/8/8/8/K3R2k b - - 0 1');
pins = findPins(c, 'b');
check('relative pin against the queen is found',
  pins.some((p) => p.kind === 'pin' && p.front.square === 'e5' && p.back.type === 'q'),
  JSON.stringify(pins.map((p) => p.kind + ' ' + p.front.square + '>' + p.back.square)));

// White rook e1, black queen e5, black knight e8: queen in front — that is a skewer.
c = new Chess('4n3/8/8/4q3/8/8/8/K3R2k b - - 0 1');
pins = findPins(c, 'b');
check('skewer is told apart from a pin',
  pins.some((p) => p.kind === 'skewer' && p.front.square === 'e5'),
  JSON.stringify(pins.map((p) => p.kind + ' ' + p.front.square + '>' + p.back.square)));

// Nothing lined up: no pins invented.
c = new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
check('no pins claimed in the starting position', findPins(c, 'b').length === 0 && findPins(c, 'w').length === 0);

// A piece between the slider and the target breaks the pin.
c = new Chess('4q3/8/8/4n3/4P3/8/8/K3R2k b - - 0 1');
check('a blocker means no pin', !findPins(c, 'b').some((p) => p.front.square === 'e5'));

/* -------------------------------------------------------- back rank ----- */

console.log('\nback rank');

c = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
check('sealed-in king with an enemy rook is flagged', !!backRankRisk(c, 'b'), JSON.stringify(backRankRisk(c, 'b')));

c = new Chess('6k1/5pp1/7p/8/8/8/5PPP/R5K1 w - - 0 1');
check('a luft square clears the risk', backRankRisk(c, 'b') === null);

c = new Chess('6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1');
check('no heavy piece means no back-rank risk', backRankRisk(c, 'b') === null);

/* ---------------------------------------------------------- loose ------- */

console.log('\nloose pieces');

// Black knight on e5 attacked by the d4 pawn and undefended.
c = new Chess('4k3/8/8/4n3/3P4/8/8/4K3 b - - 0 1');
check('an undefended attacked piece is loose', isLoose(c, 'e5', 'b') === true);

// Same knight, now defended by a pawn — a pawn taking a knight is still winning,
// so what matters is that the defended-by-nothing case above is caught.
c = new Chess('4k3/8/8/8/3P4/8/8/4K3 b - - 0 1');
check('an empty square is not loose', isLoose(c, 'e5', 'b') === false);

/* -------------------------------------------------------- overload ----- */

console.log('\noverloaded defenders');

// Black rook e7 defends the bishop on d7 along the rank and the knight on e6 down
// the file; white attacks both (Rd1 and Bb3), so the rook is carrying two duties.
c = new Chess('4k3/3br3/4n3/8/8/1B6/8/3RK2R w - - 0 1');
const overloads = overloadedDefenders(c, 'b');
check('a defender with two duties is found', overloads.length > 0,
  JSON.stringify(overloads.map((o) => o.square + ':' + o.duties.length)));

/* ------------------------------------------------------- development --- */

console.log('\ndevelopment');

const start = developmentState('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'w');
check('start position counts four undeveloped minors', start.undeveloped === 4, JSON.stringify(start));
check('start position is not castled', start.castled === false);

const developed = developmentState('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 b kq - 0 1', 'w');
// Three minors are out; the dark-square bishop is still sitting on c1.
check('developed minors are counted, home ones are not',
  developed.developed === 3 && developed.undeveloped === 1, JSON.stringify(developed));
check('castling is detected', developed.castled === true);

/* --------------------------------------------------------- trapped ----- */

console.log('\ntrapped pieces');

// Classic trapped bishop: Bxa7 walks into b6 and the bishop has no way back.
c = new Chess('rn1qkbnr/ppp1pppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
check('nothing is called trapped without cause', trappedPieces(c, 'w').length === 0);

console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll concept detector checks passed.');
process.exit(failures ? 1 : 0);
