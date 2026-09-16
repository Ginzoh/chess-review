/**
 * Minimal Chrome DevTools Protocol client: enough to launch a headless
 * Edge/Chrome, drive a page and read results back. Used by the test scripts.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

export function findBrowser() {
  return BROWSER_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Connection {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', () => reject(new Error('CDP socket error')));
    });
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

/**
 * Launch a headless browser and attach to a fresh page.
 * Returns a small facade: { evaluate, waitFor, navigate, screenshot, errors, close }.
 */
export async function launch(options) {
  const opts = options || {};
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('No Edge or Chrome installation found');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-review-cdp-'));
  const port = opts.port || 9222;
  const child = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=' + (opts.width || 1500) + ',' + (opts.height || 1000),
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) version = await res.json();
    } catch (e) {
      await sleep(250);
    }
  }
  if (!version) throw new Error('DevTools endpoint never came up');

  const cdp = new Connection(version.webSocketDebuggerUrl);
  await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);

  /** Headless defaults to "reduce", which switches off animation - emulate a real user. */
  async function setReducedMotion(value) {
    await cdp.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value: value }] },
      sessionId
    );
  }
  await setReducedMotion(opts.reducedMotion || 'no-preference');

  async function evaluate(expression, awaitPromise) {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: !!awaitPromise, timeout: 600000 },
      sessionId
    );
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception ? res.exceptionDetails.exception.description : 'evaluation threw'
      );
    }
    return res.result.value;
  }

  async function waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      if (await evaluate('!!(' + expression + ')')) return true;
      await sleep(300);
    }
    throw new Error('Timed out waiting for ' + (label || expression));
  }

  return {
    cdp,
    sessionId,
    evaluate,
    waitFor,
    setReducedMotion,
    navigate: (url) => cdp.send('Page.navigate', { url }, sessionId),
    async screenshot(file, fullPage) {
      const params = { format: 'png' };
      if (fullPage) {
        const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
        const size = metrics.cssContentSize || metrics.contentSize;
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
      const shot = await cdp.send('Page.captureScreenshot', params, sessionId);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    errors() {
      return cdp.events
        .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
        .map((e) => e.params.entry.text + ' ' + (e.params.entry.url || ''))
        .filter((t) => !/favicon/i.test(t));
    },
    async close() {
      try {
        await cdp.send('Browser.close');
      } catch (e) {
        /* already gone */
      }
      child.kill();
    }
  };
}
