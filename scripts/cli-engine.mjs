/**
 * Node-side stand-in for public/js/engine.js: same `newGame` / `analyse` surface,
 * but talking to the Stockfish CLI over stdio instead of a Web Worker.
 * Used by the scripts in this folder to exercise the real analysis pipeline.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(here, '..', 'node_modules', 'stockfish', 'bin', 'stockfish-18-lite-single.js');

export class CliEngine {
  constructor() {
    this.proc = spawn(process.execPath, [ENGINE], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.handlers = new Set();
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop();
      for (const line of lines) for (const h of Array.from(this.handlers)) h(line);
    });
  }

  send(cmd) {
    this.proc.stdin.write(cmd + '\n');
  }

  waitFor(pattern) {
    return new Promise((resolve) => {
      const h = (line) => {
        if (pattern.test(line)) {
          this.handlers.delete(h);
          resolve(line);
        }
      };
      this.handlers.add(h);
    });
  }

  async boot() {
    this.send('uci');
    await this.waitFor(/^uciok/);
    this.send('setoption name Hash value 64');
    this.send('isready');
    await this.waitFor(/^readyok/);
  }

  async newGame() {
    this.send('ucinewgame');
    this.send('isready');
    await this.waitFor(/^readyok/);
  }

  analyse(fen, opts) {
    const depth = (opts && opts.depth) || 14;
    const multipv = (opts && opts.multipv) || 2;
    return new Promise((resolve) => {
      const best = new Map();
      let reached = 0;
      const handler = (line) => {
        if (line.startsWith('info ') && line.includes(' pv ') && !/\b(lowerbound|upperbound)\b/.test(line)) {
          const parsed = parseInfo(line);
          if (parsed) {
            const prev = best.get(parsed.multipv);
            if (!prev || parsed.depth >= prev.depth) best.set(parsed.multipv, parsed);
            if (parsed.depth > reached) reached = parsed.depth;
          }
        } else if (line.startsWith('bestmove')) {
          this.handlers.delete(handler);
          const lines = Array.from(best.values()).sort((a, b) => a.multipv - b.multipv);
          resolve({ lines, depth: reached, terminal: !lines.length });
        }
      };
      this.handlers.add(handler);
      this.send('setoption name MultiPV value ' + multipv);
      this.send('position fen ' + fen);
      const limits = ['depth ' + depth];
      if (opts && opts.movetime) limits.push('movetime ' + opts.movetime);
      this.send('go ' + limits.join(' '));
    });
  }

  quit() {
    this.send('quit');
    this.proc.kill();
  }
}

function parseInfo(line) {
  const t = line.split(/\s+/);
  const out = { multipv: 1, cp: null, mate: null, pv: [], depth: 0 };
  for (let i = 0; i < t.length; i++) {
    if (t[i] === 'depth') out.depth = Number(t[++i]);
    else if (t[i] === 'multipv') out.multipv = Number(t[++i]);
    else if (t[i] === 'score') {
      if (t[i + 1] === 'cp') {
        out.cp = Number(t[i + 2]);
        i += 2;
      } else if (t[i + 1] === 'mate') {
        out.mate = Number(t[i + 2]);
        i += 2;
      }
    } else if (t[i] === 'pv') {
      out.pv = t.slice(i + 1);
      i = t.length;
    }
  }
  if (!out.pv.length) return null;
  if (out.cp === null && out.mate === null) return null;
  return out;
}
