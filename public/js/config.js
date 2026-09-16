/**
 * Where the app is running. The local server proxies Chess.com and stamps builds;
 * a static host (GitHub Pages) has neither, so the front end talks to Chess.com
 * directly and skips the stale-tab check. scripts/build-static.mjs flips this.
 */
export const STATIC_HOST = false;
