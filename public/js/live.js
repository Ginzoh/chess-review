/**
 * Live engine lines for whatever position is on the board.
 *
 * One streaming search at a time: asking for a new position stops the current
 * search, waits for the engine to acknowledge, and starts again. Results are
 * converted to SAN and to White's point of view before they reach the UI, so the
 * panel and the evaluation bar read the same way as the rest of the review.
 *
 * The full-game review uses the same engine, one blocking search at a time, so it
 * pauses this while it runs and resumes afterwards.
 */

import { Chess } from './chessutils.js';

export const LIVE_MULTIPV = 3;
export const LIVE_DEPTH = 22;

export class LiveAnalysis {
  /**
   * @param {import('./engine.js').Engine} engine
   * @param {(result: LiveResult | null) => void} onUpdate  null means "nothing yet" (cleared)
   */
  constructor(engine, onUpdate) {
    this.engine = engine;
    this.onUpdate = onUpdate;
    this.enabled = true;
    this.paused = false;
    this.fen = null;
    this._current = null;
    this._chain = Promise.resolve();
    this._generation = 0;
  }

  /** Follow a new position. Cheap to call repeatedly; only the last one wins. */
  set(fen) {
    this.fen = fen;
    this._restart();
  }

  setEnabled(on) {
    this.enabled = on;
    this._restart();
  }

  /** Resolves once the engine is idle, so a blocking search can safely begin. */
  pause() {
    this.paused = true;
    return this._restart();
  }

  resume() {
    this.paused = false;
    this._restart();
  }

  _restart() {
    const generation = ++this._generation;
    // Serialise stop/start so two searches never overlap on the one worker.
    this._chain = this._chain.catch(() => {}).then(async () => {
      if (this._current) {
        this._current.stop();
        await this._current.done;
        this._current = null;
      }
      if (generation !== this._generation) return; // superseded while stopping
      if (!this.enabled || this.paused || !this.fen) {
        this.onUpdate(null);
        return;
      }
      const fen = this.fen;
      const chess = new Chess(fen);
      if (chess.isGameOver()) {
        this.onUpdate({ fen: fen, depth: 0, lines: [], terminal: chess.isCheckmate() ? 'checkmate' : 'draw' });
        return;
      }
      await this.engine.boot();
      if (generation !== this._generation) return;
      this.onUpdate({ fen: fen, depth: 0, lines: [], terminal: null });
      this._current = this.engine.analyseStream(fen, { multipv: LIVE_MULTIPV, depth: LIVE_DEPTH }, (lines, depth) => {
        if (generation !== this._generation) return;
        this.onUpdate(toResult(fen, lines, depth));
      });
    });
    return this._chain;
  }
}

/**
 * @typedef {{fen: string, depth: number, terminal: string|null,
 *            lines: Array<{whiteCp: number, mate: number|null, san: string[], uci: string[], first: {from: string, to: string}}>}} LiveResult
 */

/** Engine output (side-to-move scores, UCI moves) -> what the panel shows. */
export function toResult(fen, lines, depth) {
  const chess = new Chess(fen);
  const toMove = chess.turn();
  const out = [];
  for (const line of lines) {
    const board = new Chess(fen);
    const san = [];
    const uci = [];
    for (const move of line.pv) {
      let made = null;
      try {
        made = board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.length > 4 ? move[4] : undefined });
      } catch (e) {
        made = null;
      }
      if (!made) break;
      san.push(made.san);
      uci.push(move);
    }
    if (!san.length) continue;
    // Mate is signed from the mover's side; cp is turned to White's point of view
    // and a mate score is folded into cp the way the review does, so the bar agrees.
    const mate = line.mate;
    const cpMover = mate !== null ? (mate > 0 ? 10000 - Math.abs(mate) * 10 : -10000 + Math.abs(mate) * 10) : line.cp;
    out.push({
      whiteCp: toMove === 'w' ? cpMover : -cpMover,
      mate: mate === null ? null : (toMove === 'w' ? mate : -mate),
      san: san,
      uci: uci,
      first: { from: uci[0].slice(0, 2), to: uci[0].slice(2, 4) }
    });
  }
  return { fen: fen, depth: depth, lines: out, terminal: null };
}

/** "9... Qd4+ 10. Rf2 Qxc4" from a FEN and SAN list. */
export function numberedLine(fen, sans, limit) {
  const parts = fen.split(' ');
  let moveNumber = Number(parts[5]) || 1;
  let white = parts[1] !== 'b';
  const out = [];
  const max = limit || sans.length;
  for (let i = 0; i < sans.length && i < max; i++) {
    if (white) out.push(moveNumber + '.');
    else if (i === 0) out.push(moveNumber + '...');
    out.push(sans[i]);
    if (!white) moveNumber++;
    white = !white;
  }
  return out.join(' ');
}
