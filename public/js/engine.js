/**
 * Stockfish 18 (WASM) wrapped in a small promise-based UCI client.
 *
 * The engine build is itself a Web Worker, so searches never block the UI thread.
 * When the page is cross-origin isolated we load the multi-threaded build and give it
 * real threads; otherwise we fall back to the single-threaded build.
 */

// Relative to this module so the app works from a sub-path (e.g. GitHub Pages).
const MT_BUILD = new URL('../engine/stockfish-18-lite.js', import.meta.url).href;
const ST_BUILD = new URL('../engine/stockfish-18-lite-single.js', import.meta.url).href;

export class Engine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.threads = 1;
    this.multithreaded = false;
    this._lineHandlers = new Set();
    this._booting = null;
  }

  get isMultithreaded() {
    return this.multithreaded;
  }

  /** Boot the worker and finish `uci` + `isready` handshakes. Safe to call repeatedly. */
  boot() {
    if (this._booting) return this._booting;

    this._booting = new Promise((resolve, reject) => {
      const isolated = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
      const url = isolated ? MT_BUILD : ST_BUILD;
      this.multithreaded = isolated;

      let worker;
      try {
        worker = new Worker(url);
      } catch (err) {
        reject(new Error('Could not start the engine worker: ' + err.message));
        return;
      }
      this.worker = worker;

      worker.onerror = (e) => reject(new Error('Engine worker error: ' + (e.message || 'unknown')));
      worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : (e.data && e.data.line) || '';
        if (!line) return;
        for (const h of this._lineHandlers) h(line);
      };

      const waitFor = (pattern) =>
        new Promise((res) => {
          const handler = (line) => {
            if (pattern.test(line)) {
              this._lineHandlers.delete(handler);
              res(line);
            }
          };
          this._lineHandlers.add(handler);
        });

      const timeout = setTimeout(() => reject(new Error('Engine did not respond in time (still downloading?)')), 90000);

      (async () => {
        this.send('uci');
        await waitFor(/^uciok/);

        if (isolated) {
          const cores = navigator.hardwareConcurrency || 4;
          this.threads = Math.max(1, Math.min(8, cores - 1));
          this.send('setoption name Threads value ' + this.threads);
          this.send('setoption name Hash value 128');
        } else {
          this.threads = 1;
          this.send('setoption name Hash value 32');
        }
        this.send('setoption name MultiPV value 2');
        this.send('setoption name UCI_AnalyseMode value true');
        this.send('isready');
        await waitFor(/^readyok/);

        clearTimeout(timeout);
        this.ready = true;
        resolve(this);
      })().catch(reject);
    });

    return this._booting;
  }

  send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  /** Drop all state between games so one game's hash table can't colour the next. */
  async newGame() {
    this.send('ucinewgame');
    this.send('isready');
    await new Promise((resolve) => {
      const handler = (line) => {
        if (/^readyok/.test(line)) {
          this._lineHandlers.delete(handler);
          resolve();
        }
      };
      this._lineHandlers.add(handler);
    });
  }

  /**
   * Search one position.
   *
   * @param {string} fen
   * @param {{depth?: number, movetime?: number, multipv?: number}} opts
   * @returns {Promise<{lines: Array<{multipv:number, cp:number|null, mate:number|null, pv:string[], depth:number}>, depth:number}>}
   *          Scores are always from the side-to-move's point of view.
   */
  analyse(fen, opts) {
    const options = opts || {};
    const depth = options.depth || 14;
    const multipv = options.multipv || 2;

    return new Promise((resolve) => {
      const best = new Map(); // multipv index -> deepest line seen
      let reachedDepth = 0;

      const handler = (line) => {
        if (line.startsWith('info ') && line.indexOf(' pv ') !== -1) {
          const parsed = parseInfo(line);
          if (!parsed) return;
          const prev = best.get(parsed.multipv);
          // Keep only the deepest report for each PV slot; ignore lower-depth stragglers.
          if (!prev || parsed.depth >= prev.depth) best.set(parsed.multipv, parsed);
          if (parsed.depth > reachedDepth) reachedDepth = parsed.depth;
        } else if (line.startsWith('bestmove')) {
          this._lineHandlers.delete(handler);
          const lines = Array.from(best.values()).sort((a, b) => a.multipv - b.multipv);
          // A terminal position (mate/stalemate) reports no PV at all.
          if (!lines.length) {
            const bm = line.split(/\s+/)[1];
            resolve({ lines: [], depth: 0, terminal: !bm || bm === '(none)' });
            return;
          }
          resolve({ lines: lines, depth: reachedDepth, terminal: false });
        }
      };

      this._lineHandlers.add(handler);
      this.send('setoption name MultiPV value ' + multipv);
      this.send('position fen ' + fen);
      // Depth and movetime may be combined: the search stops at whichever comes first,
      // which is how the mate hunt gets a deep look at a bounded cost.
      const limits = [];
      if (options.depth || !options.movetime) limits.push('depth ' + depth);
      if (options.movetime) limits.push('movetime ' + options.movetime);
      this.send('go ' + limits.join(' '));
    });
  }

  stop() {
    this.send('stop');
  }

  quit() {
    if (!this.worker) return;
    this.send('quit');
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this._booting = null;
    this._lineHandlers.clear();
  }
}

/** Pull the fields we care about out of a UCI `info` line. */
function parseInfo(line) {
  const tokens = line.split(/\s+/);
  const out = { multipv: 1, cp: null, mate: null, pv: [], depth: 0 };
  for (let i = 0; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        out.depth = Number(tokens[++i]);
        break;
      case 'multipv':
        out.multipv = Number(tokens[++i]);
        break;
      case 'score':
        if (tokens[i + 1] === 'cp') {
          out.cp = Number(tokens[i + 2]);
          i += 2;
        } else if (tokens[i + 1] === 'mate') {
          out.mate = Number(tokens[i + 2]);
          i += 2;
        }
        break;
      case 'pv':
        out.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
        break;
    }
  }
  if (!out.pv.length) return null;
  if (out.cp === null && out.mate === null) return null;
  // Ignore "lowerbound"/"upperbound" fly-by scores from aspiration windows.
  if (/\b(lowerbound|upperbound)\b/.test(line)) return null;
  return out;
}
