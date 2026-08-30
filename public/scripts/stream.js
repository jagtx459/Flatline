/**
 * A subscription to /api/stream that does not outlive the page it belongs to.
 *
 * The server sends a bare "something changed" ping and the caller fetches
 * whatever it needs. What matters here is the connection's lifetime, not its
 * contents: a browser allows only a handful of simultaneous connections to one
 * origin — six, on the HTTP/1.1 this server speaks — and an open stream holds
 * one of them for as long as its page is alive.
 *
 * A page put in the back/forward cache is not destroyed, so a stream left open
 * keeps its connection. Move back and forth between pages and those stack up,
 * until nothing can get a connection at all — not the next page's data, not its
 * stylesheet, not even its HTML. The page simply never renders. So the stream is
 * released the moment the page goes away, and reopened if it comes back.
 *
 * A factory, deliberately, rather than one connection shared through module
 * state: a module holding a live connection is a singleton that outlives the
 * document that opened it, which is the same trap in a different shape.
 */

/**
 * Calls `fn` whenever the server reports a change.
 *
 * `health` says this page shows action-target connectivity dots, which is what
 * puts the server's target poller on its fast cadence — a real connection to
 * every target every ten seconds. Pages that don't show them leave it off; see
 * openEventStream in server/index.js.
 */
export function onServerChange(fn, { health = false } = {}) {
  const url = health ? '/api/stream?health=1' : '/api/stream';
  let source = null;

  function open() {
    if (source) return;
    source = new EventSource(url);
    // EventSource reconnects on its own if the stream drops; the caller's poll
    // carries the page while it does.
    source.addEventListener('change', fn);
  }

  function close() {
    source?.close();
    source = null;
  }

  open();

  // Fires both on a real navigation away and on the way into the back/forward
  // cache, which is the one that matters: that page lives on, holding its
  // connection, while the page you moved to is trying to load.
  window.addEventListener('pagehide', close);

  // Restored from that cache: live again, but carrying whatever it last knew.
  // Reconnecting alone would leave it stale until the next ping, so it refetches
  // rather than waiting to be told something changed.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    open();
    fn();
  });
}
