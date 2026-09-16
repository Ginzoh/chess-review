/**
 * Board rendering: an 8x8 grid of squares, vector pieces drawn from an SVG
 * sprite, and an SVG overlay for the "play this instead" arrow.
 */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/**
 * Pieces are drawn from an SVG sprite (the Cburnett Wikimedia set, CC BY-SA 3.0,
 * vendored at public/assets/pieces.svg). The sprite is injected into the document
 * once and each square references a piece by id, so the board is real vector art
 * rather than outlined text glyphs.
 */
const SPRITE_URL = new URL('../assets/pieces.svg', import.meta.url).href;
const SPRITE_ID = 'piece-sprite';

export async function loadPieceSprite() {
  if (document.getElementById(SPRITE_ID)) return;
  const res = await fetch(SPRITE_URL);
  if (!res.ok) throw new Error('Could not load the piece sprite');
  const holder = document.createElement('div');
  holder.id = SPRITE_ID;
  // Kept in the document but out of the layout; <use> can still reference it.
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = await res.text();
  document.body.appendChild(holder);
}

const ANIM_MS = 180;
const ANIM_EASING = 'cubic-bezier(.25,.46,.45,.94)';

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Map of square name -> FEN piece letter. */
export function piecesFromFen(fen) {
  const map = new Map();
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let fileIndex = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        fileIndex += Number(ch);
        continue;
      }
      map.set(FILES[fileIndex] + (8 - r), ch);
      fileIndex++;
    }
  }
  return map;
}

function makePiece(ch) {
  const isWhite = ch === ch.toUpperCase();
  const id = (isWhite ? 'w' : 'b') + ch.toLowerCase();

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'piece ' + (isWhite ? 'white' : 'black'));
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.dataset.piece = id;

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

function squareDistance(a, b) {
  return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));
}

/**
 * Work out what changed between two placements.
 *
 * Everything that left a square goes in `removed`, everything that appeared goes in
 * `added`, then each arrival is paired with the departure of the same piece (nearest
 * one wins, which keeps two knights from swapping identities). A promotion has no
 * exact match, so it falls back to a departure of the same colour. Whatever is left
 * over was captured (`fadeOut`) or, stepping backwards, un-captured (`fadeIn`).
 */
export function diffPositions(before, after) {
  const removed = [];
  const added = [];

  for (const [square, piece] of before) {
    if (after.get(square) !== piece) removed.push({ square: square, piece: piece });
  }
  for (const [square, piece] of after) {
    if (before.get(square) !== piece) added.push({ square: square, piece: piece });
  }

  const moves = [];
  const isWhite = (p) => p === p.toUpperCase();

  for (const arrival of added) {
    let candidates = removed.filter((r) => r.piece === arrival.piece);
    if (!candidates.length) candidates = removed.filter((r) => isWhite(r.piece) === isWhite(arrival.piece));
    if (!candidates.length) continue;

    candidates.sort((a, b) => squareDistance(a.square, arrival.square) - squareDistance(b.square, arrival.square));
    const origin = candidates[0];
    removed.splice(removed.indexOf(origin), 1);
    arrival.matched = true;
    moves.push({ from: origin.square, to: arrival.square, piece: arrival.piece });
  }

  return {
    moves: moves,
    fadeOut: removed,
    fadeIn: added.filter((a) => !a.matched)
  };
}

export class Board {
  constructor(root) {
    this.root = root;
    this.flipped = false;
    this.squares = new Map();
    this._animation = null;
    this._last = null;

    this.grid = document.createElement('div');
    this.grid.className = 'board-grid';

    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('class', 'board-overlay');
    this.overlay.setAttribute('viewBox', '0 0 8 8');
    this.overlay.setAttribute('preserveAspectRatio', 'none');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML =
      '<marker id="arrowhead" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto">' +
      '<path d="M 0 1 L 8 5 L 0 9 z" fill="currentColor"/></marker>';
    this.overlay.appendChild(defs);

    this.root.classList.add('board');
    this.root.appendChild(this.grid);
    this.root.appendChild(this.overlay);

    this._buildSquares();
  }

  _buildSquares() {
    this.grid.innerHTML = '';
    this.squares.clear();
    const ranks = this.flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = this.flipped ? FILES.slice().reverse() : FILES;

    for (const rank of ranks) {
      for (const file of files) {
        const name = file + rank;
        const el = document.createElement('div');
        el.className = 'sq ' + ((FILES.indexOf(file) + rank) % 2 === 0 ? 'dark' : 'light');
        el.dataset.square = name;

        if (file === files[0]) {
          const r = document.createElement('span');
          r.className = 'coord rank';
          r.textContent = rank;
          el.appendChild(r);
        }
        if (rank === ranks[ranks.length - 1]) {
          const f = document.createElement('span');
          f.className = 'coord file';
          f.textContent = file;
          el.appendChild(f);
        }

        this.grid.appendChild(el);
        this.squares.set(name, el);
      }
    }
  }

  flip() {
    // Squares are about to be rebuilt, so nothing mid-flight can be allowed to finish.
    this._finishAnimation();
    this.flipped = !this.flipped;
    this._buildSquares();
    if (!this._last) return;
    const fen = this._last.fen;
    const opts = this._last.opts;
    this._last = null; // a flip is not a move, so leave no baseline to animate from
    this.setPosition(fen, Object.assign({}, opts, { animate: false }));
  }

  setOrientation(color) {
    const wantFlipped = color === 'b';
    if (wantFlipped !== this.flipped) this.flip();
  }

  /**
   * @param {string} fen
   * @param {{lastMove?:{from:string,to:string}, arrow?:{from:string,to:string,kind?:string}, check?:string}} opts
   */
  setPosition(fen, opts) {
    const options = opts || {};
    const previousFen = this._last ? this._last.fen : null;

    // Any animation still running belongs to a position we are about to replace.
    this._finishAnimation();

    // Store without the animate flag so a later flip() replays this position statically.
    this._last = { fen: fen, opts: Object.assign({}, options, { animate: false }) };

    for (const el of this.squares.values()) {
      el.classList.remove('from', 'to', 'in-check');
      for (const piece of Array.from(el.querySelectorAll('.piece'))) piece.remove();
    }

    for (const [square, ch] of piecesFromFen(fen)) {
      const el = this.squares.get(square);
      if (el) el.appendChild(makePiece(ch));
    }

    if (options.animate && previousFen && previousFen !== fen && !prefersReducedMotion()) {
      this._animate(piecesFromFen(previousFen), piecesFromFen(fen));
    }

    if (options.lastMove) {
      const from = this.squares.get(options.lastMove.from);
      const to = this.squares.get(options.lastMove.to);
      if (from) from.classList.add('from');
      if (to) to.classList.add('to');
    }
    if (options.check) {
      const el = this.squares.get(options.check);
      if (el) el.classList.add('in-check');
    }

    this._drawArrow(options.arrow);
  }

  /**
   * Slide pieces from where they stood into where they now stand.
   *
   * The new position is already in the DOM; we work out what moved by diffing the
   * two placements, start each moved piece off at its old square with a transform,
   * then let it transition back to zero. Because the diff is symmetric it handles
   * castling (two pieces), en passant (a capture away from the landing square) and
   * promotion, and it animates just as correctly when stepping backwards.
   */
  _animate(before, after) {
    const plan = diffPositions(before, after);
    if (!plan.moves.length && !plan.fadeOut.length && !plan.fadeIn.length) return;

    const cleanup = [];

    for (const move of plan.moves) {
      const fromEl = this.squares.get(move.from);
      const toEl = this.squares.get(move.to);
      if (!fromEl || !toEl) continue;
      const piece = toEl.querySelector('.piece');
      if (!piece) continue;

      const start = fromEl.getBoundingClientRect();
      const end = toEl.getBoundingClientRect();
      piece.style.transition = 'none';
      piece.style.transform = 'translate(' + (start.left - end.left) + 'px, ' + (start.top - end.top) + 'px)';
      piece.style.zIndex = '6';
      cleanup.push({ el: piece, remove: false });
    }

    // Captured pieces are already gone from the DOM; put them back briefly to fade.
    for (const gone of plan.fadeOut) {
      const el = this.squares.get(gone.square);
      if (!el) continue;
      const ghost = makePiece(gone.piece);
      ghost.classList.add('ghost');
      ghost.style.transition = 'none';
      ghost.style.opacity = '1';
      el.appendChild(ghost);
      cleanup.push({ el: ghost, remove: true });
    }

    // Stepping backwards brings a captured piece back - fade it in rather than pop it.
    for (const back of plan.fadeIn) {
      const el = this.squares.get(back.square);
      if (!el) continue;
      const piece = el.querySelector('.piece');
      if (!piece) continue;
      piece.style.transition = 'none';
      piece.style.opacity = '0';
      cleanup.push({ el: piece, remove: false });
    }

    // Flush the starting state, then let everything transition to its resting place.
    void this.grid.offsetWidth;

    for (const item of cleanup) {
      item.el.style.transition = 'transform ' + ANIM_MS + 'ms ' + ANIM_EASING + ', opacity ' + ANIM_MS + 'ms linear';
      item.el.style.transform = 'translate(0px, 0px)';
      item.el.style.opacity = item.remove ? '0' : '1';
    }

    this._animation = {
      items: cleanup,
      timer: setTimeout(() => this._finishAnimation(), ANIM_MS + 40)
    };
  }

  /** Snap every in-flight animation to its end state, immediately. */
  _finishAnimation() {
    const running = this._animation;
    if (!running) return;
    this._animation = null;
    clearTimeout(running.timer);
    for (const item of running.items) {
      if (item.remove) {
        item.el.remove();
        continue;
      }
      item.el.style.transition = '';
      item.el.style.transform = '';
      item.el.style.opacity = '';
      item.el.style.zIndex = '';
    }
  }

  _centre(square) {
    const file = FILES.indexOf(square[0]);
    const rank = Number(square[1]) - 1;
    const x = this.flipped ? 7 - file : file;
    const y = this.flipped ? rank : 7 - rank;
    return { x: x + 0.5, y: y + 0.5 };
  }

  _drawArrow(arrow) {
    for (const node of Array.from(this.overlay.querySelectorAll('line'))) node.remove();
    if (!arrow) return;

    const a = this._centre(arrow.from);
    const b = this._centre(arrow.to);

    // Stop the line short so the head sits inside the destination square.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const endX = b.x - (dx / len) * 0.32;
    const endY = b.y - (dy / len) * 0.32;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', endX);
    line.setAttribute('y2', endY);
    line.setAttribute('class', 'arrow ' + (arrow.kind || 'best'));
    line.setAttribute('marker-end', 'url(#arrowhead)');
    this.overlay.appendChild(line);
  }
}
