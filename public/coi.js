/*
 * Cross-origin isolation without server headers.
 *
 * The multi-threaded engine needs SharedArrayBuffer, which browsers only enable
 * when the page is served with COOP/COEP headers. The local server sends them;
 * a static host like GitHub Pages cannot. This file does double duty: included
 * as a script it registers itself as a service worker, and as the service worker
 * it adds the headers to every response. One reload on the first visit, then the
 * page is cross-origin isolated. Does nothing when the headers are already there.
 */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
    // Only our own files need the headers (the document and the engine worker).
    // Cross-origin requests - Chess.com, avatars - pass through untouched.
    if (new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(
      fetch(request).then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      })
    );
  });
} else if (!window.crossOriginIsolated && 'serviceWorker' in navigator) {
  // First visit: the worker takes control of this page once it activates (via
  // clients.claim), and only a load made under it carries the headers - so reload.
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  navigator.serviceWorker.register(document.currentScript.src).catch(() => { /* the single-threaded engine still works */ });
}
