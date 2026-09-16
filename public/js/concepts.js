/**
 * Board-pattern detection, and the catalogue of chess concepts the coach draws on.
 *
 * Everything here is computed from the position - no guessing at motifs we cannot
 * actually see. If a pin is named, a pin was found by walking the ray; if the coach
 * says a piece was loose, static exchange evaluation said so. That restraint is the
 * point: a coach that invents themes teaches the wrong lesson.
 */

import { Chess, PIECE_VALUE, pieceName, seeAt } from './chessutils.js';

const FILES = 'abcdefgh';

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function fileOf(square) {
  return FILES.indexOf(square[0]);
}
function rankOf(square) {
  return Number(square[1]) - 1;
}
function squareAt(file, rank) {
  return FILES[file] + (rank + 1);
}
function slideDirs(type) {
  if (type === 'r') return ROOK_DIRS;
  if (type === 'b') return BISHOP_DIRS;
  if (type === 'q') return ROOK_DIRS.concat(BISHOP_DIRS);
  return null;
}

/** Pieces met walking out from `square` in one direction, nearest first. */
function scanRay(chess, square, dir) {
  const found = [];
  let file = fileOf(square) + dir[0];
  let rank = rankOf(square) + dir[1];
  while (file >= 0 && file < 8 && rank >= 0 && rank < 8) {
    const name = squareAt(file, rank);
    const piece = chess.get(name);
    if (piece) found.push({ square: name, type: piece.type, color: piece.color });
    file += dir[0];
    rank += dir[1];
  }
  return found;
}

function allPieces(chess, color) {
  const out = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && (!color || sq.color === color)) out.push(sq);
    }
  }
  return out;
}

/**
 * Pins and skewers against `victimColor`: an enemy slider lined up on two of their
 * pieces with nothing in between. Front piece cheaper than the back one is a pin;
 * the other way round is a skewer.
 */
export function findPins(chess, victimColor) {
  const attackerColor = victimColor === 'w' ? 'b' : 'w';
  const out = [];

  for (const attacker of allPieces(chess, attackerColor)) {
    const dirs = slideDirs(attacker.type);
    if (!dirs) continue;
    for (const dir of dirs) {
      const line = scanRay(chess, attacker.square, dir);
      if (line.length < 2) continue;
      const front = line[0];
      const back = line[1];
      if (front.color !== victimColor || back.color !== victimColor) continue;

      const frontValue = PIECE_VALUE[front.type];
      const backValue = back.type === 'k' ? 100 : PIECE_VALUE[back.type];
      if (backValue > frontValue) {
        out.push({ kind: 'pin', attacker: attacker, front: front, back: back, absolute: back.type === 'k' });
      } else if (frontValue > backValue && frontValue >= 3) {
        out.push({ kind: 'skewer', attacker: attacker, front: front, back: back, absolute: false });
      }
    }
  }
  return out;
}

/**
 * Is `color`'s king stuck on its back rank behind its own pawns while the opponent
 * still has a rook or queen to invade with?
 */
export function backRankRisk(chess, color) {
  const king = allPieces(chess, color).find((p) => p.type === 'k');
  if (!king) return null;

  const homeRank = color === 'w' ? 0 : 7;
  if (rankOf(king.square) !== homeRank) return null;

  const forward = color === 'w' ? 1 : -1;
  const kingFile = fileOf(king.square);
  let shelter = 0;
  let escape = 0;

  for (const df of [-1, 0, 1]) {
    const file = kingFile + df;
    if (file < 0 || file > 7) continue;
    const ahead = chess.get(squareAt(file, homeRank + forward));
    if (ahead && ahead.color === color && ahead.type === 'p') shelter++;
    else escape++;
  }
  if (escape > 0 || shelter === 0) return null;

  const heavy = allPieces(chess, color === 'w' ? 'b' : 'w').filter((p) => p.type === 'r' || p.type === 'q');
  if (!heavy.length) return null;
  return { square: king.square, shelter: shelter, heavy: heavy.length };
}

/**
 * Pieces of `color` that have no safe square to go to while being attacked.
 * Only meaningful when it is `color`'s turn, since it plays out their own moves.
 */
export function trappedPieces(chess, color) {
  if (chess.turn() !== color) return [];
  const out = [];

  for (const piece of allPieces(chess, color)) {
    if (piece.type === 'k' || piece.type === 'p') continue;
    if (PIECE_VALUE[piece.type] < 3) continue;

    // Is it under threat where it stands?
    const probe = new Chess(chess.fen());
    const moves = probe.moves({ square: piece.square, verbose: true });
    const threatened = isLoose(chess, piece.square, color);
    if (!threatened) continue;

    const hasSafeSquare = moves.some((m) => {
      const after = new Chess(chess.fen());
      after.move({ from: m.from, to: m.to, promotion: m.promotion });
      return seeAt(after, m.to) <= 0;
    });
    if (!hasSafeSquare && moves.length) out.push({ square: piece.square, type: piece.type });
  }
  return out;
}

/** Would the opponent win material on this square if it were their turn? */
export function isLoose(chess, square, color) {
  const parts = chess.fen().split(' ');
  parts[1] = color === 'w' ? 'b' : 'w';
  parts[3] = '-';
  try {
    return seeAt(new Chess(parts.join(' ')), square) > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Defenders of `color` holding up more than one attacked piece at once - the classic
 * overload, where taking one of their duties away collapses the other.
 */
export function overloadedDefenders(chess, color) {
  if (!chess.attackers) return [];
  const enemy = color === 'w' ? 'b' : 'w';
  const load = new Map();

  for (const piece of allPieces(chess, color)) {
    if (piece.type === 'k') continue;
    // Only pieces the opponent is actually pressing need defending.
    if (!chess.attackers(piece.square, enemy).length) continue;
    for (const defenderSquare of chess.attackers(piece.square, color)) {
      if (defenderSquare === piece.square) continue;
      if (!load.has(defenderSquare)) load.set(defenderSquare, []);
      load.get(defenderSquare).push(piece);
    }
  }

  const out = [];
  for (const [square, duties] of load) {
    if (duties.length < 2) continue;
    const piece = chess.get(square);
    if (!piece) continue;
    out.push({ square: square, type: piece.type, duties: duties.map((d) => ({ square: d.square, type: d.type })) });
  }
  return out;
}

/** How far `color` has got with development, for opening advice. */
export function developmentState(fen, color) {
  const chess = new Chess(fen);
  const homeRank = color === 'w' ? 0 : 7;
  const minors = allPieces(chess, color).filter((p) => p.type === 'n' || p.type === 'b');
  const undeveloped = minors.filter((p) => rankOf(p.square) === homeRank);
  const king = allPieces(chess, color).find((p) => p.type === 'k');
  const queen = allPieces(chess, color).find((p) => p.type === 'q');

  return {
    undeveloped: undeveloped.length,
    developed: minors.length - undeveloped.length,
    castled: !!king && Math.abs(fileOf(king.square) - 4) >= 2,
    queenOut: !!queen && rankOf(queen.square) !== homeRank
  };
}

/* ------------------------------------------------------------- catalogue -- */

/**
 * The concepts the coach can name, each with what it means and how to train it.
 * `practise` is deliberately concrete - "look at every check" beats "calculate better".
 */
export const CONCEPTS = {
  hangingPiece: {
    name: 'Loose pieces',
    idea:
      'A piece that is attacked and not defended is the single most common way rating points ' +
      'leak away. Most blunders below master level are not deep tactics - they are pieces left ' +
      'standing where the opponent can simply take them.',
    practise:
      'Before you commit to a move, name every one of your pieces the opponent can capture, and ' +
      'check what your intended move stops defending. Grandmasters call these Loose Pieces Drop ' +
      'Off - if you only ever do one check, do this one.'
  },
  underDefended: {
    name: 'Counting exchanges',
    idea:
      'A piece can be defended and still be lost. What matters is not whether something guards it, ' +
      'but what the whole sequence of captures leaves on the board. A queen defended by a pawn is ' +
      'still hanging if a rook can take it - you win the rook back and are down the difference.',
    practise:
      'On any square where pieces meet, count attackers and defenders, then play the exchange out in ' +
      'your head cheapest piece first, and total up what each side ends with. If your piece is worth ' +
      'more than the one taking it, being "defended" does not save it.'
  },
  fork: {
    name: 'Forks and double attacks',
    idea:
      'One piece attacking two targets wins material, because only one of them can move away. ' +
      'Knights fork most often, but queens, pawns and even kings do it too.',
    practise:
      'Whenever two of your pieces sit a knight-move apart, or line up on the same rank, file or ' +
      'diagonal, treat it as a warning. Solving knight-fork puzzles trains the pattern faster ' +
      'than anything else.'
  },
  pin: {
    name: 'Pins',
    idea:
      'A pinned piece cannot move without exposing something more valuable behind it, so it stops ' +
      'defending properly. Pins against the king are absolute - that piece legally cannot move.',
    practise:
      'Look along every enemy bishop, rook and queen line before moving. Ask which of your pieces ' +
      'are standing between an enemy slider and your king or queen, and avoid piling more duties ' +
      'onto them.'
  },
  skewer: {
    name: 'Skewers',
    idea:
      'A skewer is a pin in reverse: the valuable piece is in front, and when it moves the piece ' +
      'behind it is captured. Lining your king and queen up on one file or diagonal invites it.',
    practise:
      'Keep your king and queen off the same line where you can, especially with enemy rooks and ' +
      'bishops still on the board.'
  },
  backRank: {
    name: 'Back-rank weakness',
    idea:
      'A castled king with three unmoved pawns in front of it has no escape square. A single rook ' +
      'or queen reaching that rank is mate, which means your back-rank defenders can never be ' +
      'traded off casually.',
    practise:
      'Once the queens or rooks are active, make a luft square for the king (h3 or h6 is usual), ' +
      'or make sure a defender always covers the back rank.'
  },
  trappedPiece: {
    name: 'Trapped pieces',
    idea:
      'A piece deep in enemy territory can run out of squares. It is not captured immediately - ' +
      'it simply has nowhere to go, and falls a move later.',
    practise:
      'Before sending a piece somewhere active, count the squares it can come back to. If the ' +
      'answer is none, it is a raid, not a plan.'
  },
  overload: {
    name: 'Overloaded defenders',
    idea:
      'A piece with two jobs has one job too many. Capture or deflect it and the other thing it ' +
      'was holding together falls.',
    practise:
      'When you defend a piece, ask what else that defender is doing. When you attack, look for ' +
      'the enemy piece that is doing two jobs and take one of them away.'
  },
  kingSafety: {
    name: 'King safety',
    idea:
      'Material means nothing if the king falls. Opening lines near your own king, or leaving it ' +
      'in the centre while pieces come off, converts a fine position into a lost one quickly.',
    practise:
      'Treat every enemy check as a real threat and calculate it out. Castle early, and think hard ' +
      'before pushing the pawns in front of your own king.'
  },
  missedMaterial: {
    name: 'Spotting free material',
    idea:
      'The cheapest advantage in chess is material the opponent left hanging. Missing it costs ' +
      'as much as blundering yourself.',
    practise:
      'Start every move by scanning the opponent’s undefended pieces and your available captures ' +
      'and checks, before you think about anything positional.'
  },
  calculation: {
    name: 'Forcing moves first',
    idea:
      'Checks, captures and threats are forcing - they narrow the opponent’s replies, which is ' +
      'exactly what makes them calculable. Missing a forced win almost always means the forcing ' +
      'move was never considered.',
    practise:
      'On every move, list the checks, then the captures, then the threats - for both sides - ' +
      'before you look at quiet moves.'
  },
  conversion: {
    name: 'Converting a winning position',
    idea:
      'Winning positions do not win themselves. The usual failure is drifting: making natural ' +
      'moves instead of concrete ones, and letting the opponent back into the game.',
    practise:
      'When clearly better, simplify. Trade pieces (not pawns), avoid complications you do not ' +
      'need, and push the advantage you already have rather than looking for a new one.'
  },
  development: {
    name: 'Development and the centre',
    idea:
      'The opening is a race to get pieces out, control the centre and tuck the king away. Moving ' +
      'the same piece twice, or grabbing pawns with the queen, loses that race.',
    practise:
      'Aim to have both knights and bishops out and to castle within the first ten to twelve ' +
      'moves. Move each piece once until development is finished.'
  },
  prophylaxis: {
    name: 'Asking what the opponent wants',
    idea:
      'Most positional errors come from thinking only about your own plan. The move that loses is ' +
      'usually the one that ignores what the opponent is threatening.',
    practise:
      'Before choosing, ask: if it were their turn now, what would they play? Then make sure your ' +
      'move still answers it.'
  },
  endgameTechnique: {
    name: 'Endgame technique',
    idea:
      'With few pieces left, the king becomes a fighting piece and passed pawns decide games. ' +
      'Small inaccuracies matter more here because there is less to compensate with.',
    practise:
      'Activate the king as soon as the queens come off, push passed pawns with support, and ' +
      'learn the basic rook endings - they are the ones that actually appear.'
  },
  positional: {
    name: 'Positional judgement',
    idea:
      'Not every mistake is a tactic. Giving up the centre, misplacing a piece or weakening a ' +
      'square costs slowly rather than immediately, but it costs.',
    practise:
      'Compare your worst-placed piece with theirs and ask which move improves yours most. That ' +
      'question resolves more quiet positions than any amount of calculation.'
  }
};

export { pieceName, PIECE_VALUE };
