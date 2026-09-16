/**
 * Board-level helpers used to turn engine numbers into sentences:
 * static exchange evaluation, material counting, tactical motif detection.
 */

import { Chess } from './vendor/chess.js';

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const PIECE_NAME = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king'
};

export function pieceName(type) {
  return PIECE_NAME[type] || 'piece';
}

/** "wins a rook", "wins a pawn", "wins two pawns" - value in pawn units. */
export function materialPhrase(value) {
  const v = Math.round(value);
  if (v >= 9) return 'a queen';
  if (v >= 5) return 'a rook';
  if (v >= 3) return 'a piece';
  if (v === 2) return 'two pawns';
  if (v >= 1) return 'a pawn';
  return 'material';
}

/**
 * Static exchange evaluation on one square, for whoever is to move in `chess`.
 * Plays out the capture sequence least-valuable-attacker first, allowing either
 * side to stand pat. Returns the net gain in pawn units (never negative).
 */
export function seeAt(chess, square) {
  const captures = chess
    .moves({ verbose: true })
    .filter((m) => m.to === square && m.captured);
  if (!captures.length) return 0;

  captures.sort((a, b) => PIECE_VALUE[a.piece] - PIECE_VALUE[b.piece]);
  const m = captures[0];
  let gain = PIECE_VALUE[m.captured];
  if (m.promotion) gain += PIECE_VALUE[m.promotion] - PIECE_VALUE.p;

  chess.move({ from: m.from, to: m.to, promotion: m.promotion });
  const reply = seeAt(chess, square);
  chess.undo();

  return Math.max(0, gain - reply);
}

/**
 * Net material a specific capture wins, accounting for the recapture sequence.
 * Positive means the capture is materially sound.
 */
export function captureGain(chess, move) {
  if (!move.captured) return 0;
  let gain = PIECE_VALUE[move.captured];
  if (move.promotion) gain += PIECE_VALUE[move.promotion] - PIECE_VALUE.p;
  const clone = new Chess(chess.fen());
  clone.move({ from: move.from, to: move.to, promotion: move.promotion });
  return gain - seeAt(clone, move.to);
}

/** Total non-pawn, non-king material on the board, in pawn units. */
export function nonPawnMaterial(fen) {
  const board = fen.split(' ')[0];
  let total = 0;
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (lower === 'n' || lower === 'b' || lower === 'r' || lower === 'q') total += PIECE_VALUE[lower];
  }
  return total;
}

/** Material balance in pawn units from White's point of view. */
export function materialBalance(fen) {
  const board = fen.split(' ')[0];
  let score = 0;
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (!PIECE_VALUE[lower]) continue;
    score += ch === lower ? -PIECE_VALUE[lower] : PIECE_VALUE[lower];
  }
  return score;
}

/**
 * Which pieces of `color` are currently loose - attacked and not adequately
 * defended - given it is the opponent's turn to move in `chess`.
 */
export function hangingPieces(chess, color) {
  const loose = [];
  if (chess.turn() === color) return loose; // only meaningful when the opponent can strike
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === 'k') continue;
      const gain = seeAt(new Chess(chess.fen()), sq.square);
      if (gain > 0) loose.push({ square: sq.square, type: sq.type, loss: gain });
    }
  }
  return loose.sort((a, b) => b.loss - a.loss);
}

/**
 * Does the piece that just moved to `square` attack two or more valuable targets?
 * Detects the plain double-attack / fork pattern.
 */
export function forkTargets(chess, square) {
  const piece = chess.get(square);
  if (!piece) return [];
  const attacked = [];
  const enemy = piece.color === 'w' ? 'b' : 'w';

  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== enemy) continue;
      const attackers = chess.attackers ? chess.attackers(sq.square, piece.color) : [];
      if (!attackers.includes(square)) continue;
      // Only count it as a target if it is worth more than the attacker, or undefended.
      const worthMore = PIECE_VALUE[sq.type] > PIECE_VALUE[piece.type] || sq.type === 'k';
      const undefended = !chess.attackers || chess.attackers(sq.square, enemy).length === 0;
      if (worthMore || (undefended && PIECE_VALUE[sq.type] >= 3)) {
        attacked.push({ square: sq.square, type: sq.type });
      }
    }
  }
  return attacked;
}

/** Convert a UCI move string into a chess.js move object on the given position. */
export function uciToMove(chess, uci) {
  if (!uci || uci.length < 4) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  const legal = chess.moves({ verbose: true });
  return legal.find((m) => m.from === from && m.to === to && (!promotion || m.promotion === promotion)) || null;
}

/** Turn a UCI principal variation into readable SAN, stopping at the first illegal move. */
export function pvToSan(fen, pv, limit) {
  const chess = new Chess(fen);
  const out = [];
  const max = limit || pv.length;
  for (let i = 0; i < pv.length && out.length < max; i++) {
    const move = uciToMove(chess, pv[i]);
    if (!move) break;
    const made = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    out.push(made.san);
  }
  return out;
}

/**
 * Format a PV as it would read in a book: "12. Nf3 Bg4 13. Be2".
 * `fen` fixes the move number and which side starts.
 */
export function formatVariation(fen, sanMoves) {
  const parts = fen.split(' ');
  let moveNumber = Number(parts[5]) || 1;
  let whiteToMove = parts[1] === 'w';
  const out = [];

  sanMoves.forEach((san, i) => {
    if (whiteToMove) out.push(moveNumber + '. ' + san);
    else out.push((i === 0 ? moveNumber + '... ' : '') + san);
    if (!whiteToMove) moveNumber++;
    whiteToMove = !whiteToMove;
  });
  return out.join(' ');
}

export { Chess };
