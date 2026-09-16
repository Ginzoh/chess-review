/**
 * Chess Review - local server.
 *
 * Two jobs:
 *  1. Proxy the public Chess.com API (adds a User-Agent, caches responses, keeps the browser same-origin).
 *  2. Serve the front end plus the Stockfish WASM engine with the headers that unlock SharedArrayBuffer,
 *     so the multi-threaded engine build can be used where the browser supports it.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENGINE_DIR = path.join(ROOT, 'node_modules', 'stockfish', 'bin');

const UA = 'chess-review-local/1.0 (personal game review tool)';
const API_HOST = 'api.chess.com';
const IMG_HOSTS = new Set(['images.chesscomfiles.com', 'www.chess.com', 'betacssjs.chesscomfiles.com']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

/* ----------------------------------------------------------------- cache -- */

const cache = new Map(); // key -> { expires, status, type, body }
const MAX_CACHE_ENTRIES = 400;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value, ttlMs) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, Object.assign({ expires: Date.now() + ttlMs }, value));
}

/** Past monthly archives never change; the current month still can. */
function ttlFor(pathname) {
  const m = pathname.match(/\/games\/(\d{4})\/(\d{2})$/);
  if (m) {
    const now = new Date();
    const isCurrent = Number(m[1]) === now.getUTCFullYear() && Number(m[2]) === now.getUTCMonth() + 1;
    return isCurrent ? 5 * 60e3 : 24 * 3600e3;
  }
  if (/\/games\/archives$/.test(pathname)) return 30 * 60e3;
  return 10 * 60e3;
}

/* -------------------------------------------------------------- upstream -- */

function fetchUpstream(host, reqPath, accept) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: host, path: reqPath, method: 'GET', headers: { 'User-Agent': UA, Accept: accept } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'] || 'application/octet-stream',
            body: Buffer.concat(chunks)
          })
        );
      }
    );
    req.setTimeout(20000, () => {
      req.destroy();
      resolve({ status: 504, type: 'application/json', body: Buffer.from('{"error":"upstream timeout"}') });
    });
    req.on('error', (e) =>
      resolve({
        status: 502,
        type: 'application/json',
        body: Buffer.from(JSON.stringify({ error: 'upstream error: ' + e.message }))
      })
    );
    req.end();
  });
}

/* ---------------------------------------------------------------- server -- */

function isolationHeaders(res) {
  // Required for SharedArrayBuffer, which lets us run the multi-threaded Stockfish build.
  // "credentialless" rather than "require-corp" so cross-origin avatars still load.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
}

function sendBuffer(res, status, type, buf, cacheControl) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': cacheControl || 'no-cache'
  });
  res.end(buf);
}

/**
 * Front-end files are sent with `no-cache`, which tells the browser to revalidate
 * before reuse - but revalidation needs a validator, so Last-Modified is included and
 * If-Modified-Since is honoured. Without that, every reload re-downloaded everything
 * and, worse, there was no cheap way for a page to notice its code had gone stale.
 */
function sendFile(res, filePath, req) {
  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'));

    const lastModified = new Date(st.mtimeMs);
    lastModified.setMilliseconds(0);
    const since = req && req.headers['if-modified-since'] ? new Date(req.headers['if-modified-since']) : null;
    if (since && !isNaN(since.getTime()) && lastModified <= since) {
      res.writeHead(304, { 'Last-Modified': lastModified.toUTCString(), 'Cache-Control': 'no-cache' });
      return res.end();
    }

    fs.readFile(filePath, (err, buf) => {
      if (err) return sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found'));
      const ext = path.extname(filePath).toLowerCase();
      const immutable = filePath.startsWith(ENGINE_DIR);
      res.setHeader('Last-Modified', lastModified.toUTCString());
      sendBuffer(res, 200, MIME[ext] || 'application/octet-stream', buf, immutable ? 'public, max-age=604800' : 'no-cache');
    });
  });
}

/**
 * A build stamp: the newest modification time across the front-end files. The page
 * shows it, and polls it, so a tab running stale code can say so instead of silently
 * producing results from a version that no longer exists on disk.
 */
function currentBuild() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|css|html|svg)$/.test(entry.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  try {
    walk(PUBLIC_DIR);
  } catch (e) {
    /* fall through with whatever was found */
  }
  return new Date(newest).toISOString();
}

/** Reject anything trying to climb out of the directory it is served from. */
function safeJoin(base, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch (e) {
    return null;
  }
  const target = path.normalize(path.join(base, decoded));
  return target.startsWith(base) ? target : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  isolationHeaders(res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('Method not allowed'));
  }

  // --- Chess.com public API proxy -------------------------------------------
  if (pathname.startsWith('/api/chess/')) {
    const rest = pathname.slice('/api/chess/'.length);
    if (!/^[A-Za-z0-9/_.\-%]*$/.test(rest) || rest.indexOf('..') !== -1) {
      return sendBuffer(res, 400, 'application/json', Buffer.from('{"error":"bad path"}'));
    }
    const upstreamPath = '/pub/' + rest + (url.search || '');
    const cached = cacheGet(upstreamPath);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return sendBuffer(res, cached.status, cached.type, cached.body);
    }
    const out = await fetchUpstream(API_HOST, upstreamPath, 'application/json');
    if (out.status === 200) cacheSet(upstreamPath, out, ttlFor(pathname));
    res.setHeader('X-Cache', 'MISS');
    return sendBuffer(res, out.status, out.type, out.body);
  }

  // --- Avatar / image proxy (keeps everything same-origin) -------------------
  if (pathname === '/api/img') {
    const raw = url.searchParams.get('u') || '';
    let target;
    try {
      target = new URL(raw);
    } catch (e) {
      return sendBuffer(res, 400, 'text/plain', Buffer.from('bad url'));
    }
    if (target.protocol !== 'https:' || !IMG_HOSTS.has(target.host)) {
      return sendBuffer(res, 403, 'text/plain', Buffer.from('host not allowed'));
    }
    const key = 'img:' + target.href;
    const cached = cacheGet(key);
    if (cached) return sendBuffer(res, cached.status, cached.type, cached.body, 'public, max-age=86400');
    const out = await fetchUpstream(target.host, target.pathname + target.search, 'image/*');
    if (out.status === 200) cacheSet(key, out, 24 * 3600e3);
    return sendBuffer(res, out.status, out.type, out.body, 'public, max-age=86400');
  }

  // --- Build stamp, for the stale-tab notice --------------------------------
  if (pathname === '/version') {
    return sendBuffer(res, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ build: currentBuild() })), 'no-store');
  }

  // --- Engine + libraries served straight out of node_modules ---------------
  if (pathname.startsWith('/engine/')) {
    const file = safeJoin(ENGINE_DIR, pathname.slice('/engine/'.length));
    return file ? sendFile(res, file, req) : sendBuffer(res, 403, 'text/plain', Buffer.from('forbidden'));
  }

  // --- Static front end -----------------------------------------------------
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) return sendBuffer(res, 403, 'text/plain', Buffer.from('forbidden'));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), req);
    sendFile(res, file, req);
  });
});

server.listen(PORT, () => {
  console.log('\n  Chess Review running at  http://localhost:' + PORT + '\n');
});
