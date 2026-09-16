/**
 * End-to-end check of the analysis + review pipeline, outside the browser.
 *
 * Drives the same analysis.js / insights.js the front end uses, against a real
 * Stockfish process and a real Chess.com game.
 *
 *   node scripts/selftest.mjs [username]
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import https from 'https';

import { analyseGame } from '../public/js/analysis.js';
import { buildReview, explainMove, formatCp } from '../public/js/insights.js';
import { normaliseGame } from '../public/js/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(here, '..', 'node_modules', 'stockfish', 'bin', 'stockfish-18-lite-single.js');

/* --------------------------------------------------- engine over stdio -- */

class CliEngine {
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
    const depth = opts.depth || 14;
    const multipv = opts.multipv || 2;
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
      this.send('go depth ' + depth);
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
      if (t[i + 1] === 'cp') { out.cp = Number(t[i + 2]); i += 2; }
      else if (t[i + 1] === 'mate') { out.mate = Number(t[i + 2]); i += 2; }
    } else if (t[i] === 'pv') { out.pv = t.slice(i + 1); i = t.length; }
  }
  if (!out.pv.length) return null;
  if (out.cp === null && out.mate === null) return null;
  return out;
}

/* ------------------------------------------------------------ fixtures -- */

function apiGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'chess-review-selftest/1.0', Accept: 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
          resolve(JSON.parse(data));
        });
      })
      .on('error', reject);
  });
}

async function pickGame(username) {
  const archives = await apiGet('https://api.chess.com/pub/player/' + username + '/games/archives');
  const last = archives.archives[archives.archives.length - 1];
  const month = await apiGet(last);
  const games = month.games
    .map(normaliseGame)
    .filter((g) => g.rules === 'chess' && g.pgn && g.timeClass !== 'daily');
  // A mid-length decisive game exercises the most code paths.
  const scored = games
    .map((g) => ({ g, plies: (g.pgn.match(/\d+\.\s/g) || []).length }))
    .filter((x) => x.plies >= 20 && x.plies <= 45 && x.g.result !== '1/2-1/2');
  return (scored[0] || { g: games[0] }).g;
}

/* ---------------------------------------------------------------- main -- */

const username = process.argv[2] || 'hikaru';
const depth = Number(process.env.DEPTH || 12);

console.log('Fetching a game for ' + username + ' …');
const game = await pickGame(username);
console.log('  ' + game.white.username + ' vs ' + game.black.username + '  ' + game.result + '  (' + game.timeClass + ', ' + (game.opening || game.eco) + ')');

const engine = new CliEngine();
await engine.boot();

console.log('Analysing at depth ' + depth + ' …');
const started = Date.now();
const analysis = await analyseGame(engine, game.pgn, { depth }, (done, total) => {
  if (done % 10 === 0 || done === total) process.stdout.write('  ' + done + '/' + total + '\r');
});
console.log('\nDone in ' + ((Date.now() - started) / 1000).toFixed(1) + 's for ' + analysis.moves.length + ' moves.');

/* ------ assertions ------ */

const problems = [];
const check = (label, ok, extra) => {
  if (!ok) problems.push(label + (extra ? ' — ' + extra : ''));
};

for (const m of analysis.moves) {
  check('ply ' + m.ply + ' has a label', !!m.label);
  check('ply ' + m.ply + ' accuracy in range', m.accuracy >= 0 && m.accuracy <= 100, String(m.accuracy));
  check('ply ' + m.ply + ' winLoss finite', Number.isFinite(m.winLoss), String(m.winLoss));
  check('ply ' + m.ply + ' phase set', ['opening', 'middlegame', 'endgame'].includes(m.phase), m.phase);
  const text = explainMove(m).text;
  check('ply ' + m.ply + ' explanation non-empty', typeof text === 'string' && text.length > 0);
  check('ply ' + m.ply + ' explanation has no undefined', text.indexOf('undefined') === -1, text);
  check('ply ' + m.ply + ' explanation has no NaN', text.indexOf('NaN') === -1, text);
}

for (const color of ['w', 'b']) {
  const s = analysis.stats[color];
  check(color + ' accuracy in range', s.accuracy === null || (s.accuracy >= 0 && s.accuracy <= 100), String(s.accuracy));
  const counted = Object.values(s.counts).reduce((a, b) => a + b, 0);
  check(color + ' label counts add up', counted === s.moveCount, counted + ' vs ' + s.moveCount);
}

const meta = {
  white: game.white,
  black: game.black,
  result: game.result,
  termination: game.termination,
  opening: game.opening,
  openingUrl: game.ecoUrl,
  timeClass: game.timeClass
};

for (const color of ['w', 'b']) {
  const review = buildReview(analysis, color, meta);
  check(color + ' headline present', !!review.headline && !review.headline.includes('undefined'), review.headline);
  check(color + ' has improvements', review.improvements.length > 0);
  for (const f of review.strengths.concat(review.improvements, review.keyMoments)) {
    check(color + ' finding text clean', !/undefined|NaN|\[object/.test(f.title + ' ' + f.detail), f.title + ' | ' + f.detail);
  }
}

/* ------ report ------ */

const review = buildReview(analysis, 'w', meta);
console.log('\n=== REVIEW (White: ' + game.white.username + ') ===\n');
console.log(review.headline + '\n');
console.log('Accuracy  W ' + fmt(analysis.stats.w.accuracy) + '  B ' + fmt(analysis.stats.b.accuracy));
console.log('Counts    W ' + JSON.stringify(analysis.stats.w.counts));

if (review.opening) console.log('\nOPENING: ' + review.opening.name + '\n  ' + review.opening.detail);

console.log('\nWHAT WENT WELL:');
for (const s of review.strengths) console.log('  • ' + s.title + '\n    ' + s.detail);
console.log('\nWHAT TO WORK ON:');
for (const s of review.improvements) console.log('  • ' + s.title + '\n    ' + s.detail);
console.log('\nTURNING POINTS:');
for (const s of review.keyMoments) console.log('  • ' + s.title + '\n    ' + s.detail);
if (review.time) console.log('\nCLOCK:\n  • ' + review.time.title + '\n    ' + review.time.detail);
console.log('\nPHASES: ' + review.phases.map((p) => p.name + ' ' + fmt(p.accuracy) + '%').join('  '));

const worst = analysis.moves.slice().sort((a, b) => b.winLoss - a.winLoss).slice(0, 3);
console.log('\nWORST MOVES:');
for (const m of worst) {
  console.log(
    '  ' + m.moveNumber + (m.color === 'w' ? '.' : '...') + ' ' + m.san + '  [' + m.label.text + ']  ' +
    formatCp(m.evalBeforeCp) + ' -> ' + formatCp(m.evalAfterCp)
  );
  console.log('    ' + explainMove(m).text);
}

engine.quit();

function fmt(v) {
  return v === null || v === undefined ? '—' : v.toFixed(1);
}

if (problems.length) {
  console.log('\n!! ' + problems.length + ' PROBLEMS:');
  for (const p of problems.slice(0, 25)) console.log('   - ' + p);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
