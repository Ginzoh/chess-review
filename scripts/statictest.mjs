/**
 * Checks the static build the way GitHub Pages serves it: plain files, under a
 * sub-path, no COOP/COEP headers. Builds dist/, serves it at /chess-review/, and
 * drives it in headless Edge - the service worker must make the page cross-origin
 * isolated, Chess.com must answer directly, and a review must complete.
 *
 *   node scripts/statictest.mjs [username]
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { launch, findBrowser } from './cdp.mjs';

const PORT = 5180;
const PREFIX = '/chess-review/';
const BASE = 'http://localhost:' + PORT + PREFIX;
const USERNAME = process.argv[2] || 'hikaru';
const DIST = 'dist';

if (!findBrowser()) {
  console.error('No Edge/Chrome found; skipping static test.');
  process.exit(0);
}

execFileSync('node', ['scripts/build-static.mjs', DIST], { stdio: 'inherit' });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
  p = p.slice(PREFIX.length) || 'index.html';
  const file = path.join(DIST, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const page = await launch({ port: 9223, width: 1400, height: 1000 });
const { evaluate, waitFor } = page;
// Chess.com sits behind Cloudflare, which challenges the "HeadlessChrome" user agent
// and so answers without CORS headers. Real browsers are not challenged.
const ua = (await evaluate('navigator.userAgent')).replace(/HeadlessChrome/, 'Chrome').replace(/HeadlessEdg/, 'Edg');
await page.cdp.send('Emulation.setUserAgentOverride', { userAgent: ua }, page.sessionId);
const failures = [];
const check = (label, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !extra ? '' : ' — ' + extra));
  if (!ok) failures.push(label);
};

try {
  console.log('\n1. Static home page under a sub-path');
  await page.navigate(BASE);
  await waitFor('document.querySelector(".home h1")', 15000, 'home page');
  check('home renders', true);
  check('stylesheet applied', await evaluate('getComputedStyle(document.body).margin === "0px" && !!document.querySelector(".home h1")'));

  console.log('\n2. Service worker makes the page cross-origin isolated');
  // The first load registers the worker and reloads; give it a moment.
  await waitFor('crossOriginIsolated === true', 15000, 'cross-origin isolation');
  check('crossOriginIsolated after the service-worker reload', await evaluate('crossOriginIsolated === true'));
  check('SharedArrayBuffer available', await evaluate('typeof SharedArrayBuffer !== "undefined"'));

  console.log('\n3. Chess.com answered directly');
  await evaluate('location.hash = "#/u/' + USERNAME + '"');
  await waitFor('document.querySelectorAll(".game-row").length > 0', 30000, 'games list');
  check('games listed', (await evaluate('document.querySelectorAll(".game-row").length')) > 0);
  check('avatar loaded cross-origin', await evaluate('(function(){const i=document.querySelector("#profile img"); return !i || (i.complete && i.naturalWidth > 0);})()'));

  console.log('\n4. Engine review runs from the copied WASM files');
  await evaluate('document.querySelectorAll(".game-row")[0].click()');
  await waitFor('document.querySelector("#board .sq .piece")', 15000, 'board');
  check('board pieces from the sprite', (await evaluate('document.querySelectorAll("#board .piece").length')) >= 2);
  await evaluate('document.getElementById("depth-select").value = "12"');
  await evaluate('document.getElementById("btn-analyse").click()');
  await waitFor('document.querySelector("#review-slot .finding")', 600000, 'review output');
  check('review completed', true);
  const badge = await evaluate('document.getElementById("engine-badge").textContent');
  check('multi-threaded engine was used', /threads/.test(badge), badge);

  console.log('\n5. Console errors');
  const errors = page.errors().filter((e) => !/version/.test(e));
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
} catch (err) {
  failures.push('threw: ' + err.message);
  console.error('\nERROR: ' + err.message);
  const errors = page.errors();
  if (errors.length) console.error('page errors:\n  ' + errors.slice(0, 6).join('\n  '));
} finally {
  await page.close();
  server.close();
}

console.log(failures.length ? '\n!! ' + failures.length + ' static-build failures' : '\nAll static-build checks passed.');
process.exit(failures.length ? 1 : 0);
