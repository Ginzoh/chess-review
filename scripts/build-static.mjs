/**
 * Assemble a static build of the app for hosts without our Node server (GitHub
 * Pages). Copies public/, adds the Stockfish files the server normally serves from
 * node_modules, and switches the front end to static mode so it calls Chess.com
 * directly.
 *
 *   node scripts/build-static.mjs [outDir]     # default: dist
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT = path.resolve(process.argv[2] || 'dist');
const PUBLIC = path.join(ROOT, 'public');
const ENGINE = path.join(ROOT, 'node_modules', 'stockfish', 'bin');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(PUBLIC, OUT, { recursive: true });

fs.mkdirSync(path.join(OUT, 'engine'), { recursive: true });
for (const name of fs.readdirSync(ENGINE)) {
  if (/^stockfish-18-lite(-single)?\.(js|wasm)$/.test(name)) fs.copyFileSync(path.join(ENGINE, name), path.join(OUT, 'engine', name));
}

const config = path.join(OUT, 'js', 'config.js');
const flipped = fs.readFileSync(config, 'utf8').replace('export const STATIC_HOST = false;', 'export const STATIC_HOST = true;');
if (!flipped.includes('STATIC_HOST = true')) throw new Error('could not switch config.js to static mode');
fs.writeFileSync(config, flipped);

// GitHub Pages runs Jekyll by default, which would drop files it does not like.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log('static build written to ' + OUT + ' (' + (size(OUT) / 1048576).toFixed(1) + ' MB)');
