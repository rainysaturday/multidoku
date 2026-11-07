/**
 * SudokuCoop service worker — what makes the app installable and able to open
 * without a network.
 *
 * It is plain JavaScript sitting at the site root on purpose: a service worker
 * can only control the paths under the directory it is served from, so this has
 * to be /sw.js (scope '/') rather than something compiled into /dist/client/.
 *
 * Strategy: network first, cache as fallback. The app is useless without the
 * server (the board lives behind a websocket), so freshness beats offline speed
 * whenever the server answers — and the precached shell means the app still
 * opens, draws a board and says "reconnecting" when it does not. Assets are not
 * content-hashed here, so caching them ahead of the network would pin a stale
 * bundle to every install until VERSION was bumped.
 */

/* Bump when the shell file list changes; old caches are dropped on activate. */
const VERSION = "sudoku-coop-v1";

/* Must-haves: if any of these fail to cache, the install fails loudly rather
   than serving a half-app. */
const SHELL = ["/", "/index.html", "/style.css", "/dist/client/client.js"];

/* Worth having offline, not fatal if one is missing. */
const EXTRAS = [
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/favicon.svg",
  "/icons/icon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(async (cache) => {
        await cache.addAll(SHELL);
        await Promise.allSettled(EXTRAS.map((url) => cache.add(url)));
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Only same-origin GETs of our own files; never the API probes or other sites. */
const cacheable = (url) =>
  url.origin === self.location.origin &&
  (url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/style.css" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/dist/client/") ||
    url.pathname.startsWith("/icons/"));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!cacheable(url)) return;

  /* Navigations: try the server, and if it is unreachable hand back the saved
     shell so the installed app still opens. */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match("/index.html")) ?? Response.error(),
      ),
    );
    return;
  }

  /* Assets: network when it answers, cache when it does not. */
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(VERSION);
          /* stash a clone: the page still gets to read the original body */
          await cache.put(request, response.clone());
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) ?? Response.error()),
  );
});
