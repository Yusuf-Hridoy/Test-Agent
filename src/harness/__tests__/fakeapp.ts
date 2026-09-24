import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A three-page shop used by the session integration test. It deliberately
 * misbehaves in two ways: /broken logs a console error, and /api/boom 500s.
 */
export interface FakeApp {
  url: string;
  close: () => Promise<void>;
  /** Rename the add-to-cart button, so a replay can be made to break on cue. */
  setAddLabel: (label: string) => void;
  /** Which catalogue item was last added — proves WHICH button a replay clicked. */
  lastPicked: () => string | undefined;
  /** Remove one catalogue item entirely, so a flow breaks for a real reason. */
  setCatalogue: (items: string[]) => void;
}

export async function startFakeApp(fixedPort = 0): Promise<FakeApp> {
  let addLabel = "Add to cart";
  let picked: string | undefined;
  let catalogue = ["Item A", "Item B", "Item C"];
  const page = (body: string) =>
    `<!doctype html><html><head><title>Fixture Shop</title></head><body>${body}</body></html>`;

  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/telemetry") {
      // CORS-permitted like a real analytics endpoint: the fetch completes and
      // only the 401 surfaces, with no browser-generated console error.
      res.writeHead(401, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      res.end("no");
      return;
    }
    if (url.pathname.startsWith("/picked/")) {
      picked = decodeURIComponent(url.pathname.slice("/picked/".length));
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/api/boom") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("kaboom");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    switch (url.pathname) {
      case "/inventory":
        res.end(
          page(`<h1>Inventory</h1>
            <script>fetch("http://localhost:${port}/api/telemetry").catch(() => {})</script>
            <span id="badge">cart: 0</span>
            <button id="add" onclick="document.getElementById('badge').textContent='cart: 1'">${addLabel}</button>
            <a href="/broken">Broken page</a>
            <button onclick="fetch('/api/boom')">Check out</button>
            <a href="https://example.com/outside">Our partner site</a>
            <a href="/logout">Logout</a>`),
        );
        return;
      case "/catalogue": {
        // Three products whose buttons are indistinguishable by accessible
        // name — the exact shape that defeated Phase 2 replay.
        const rows = catalogue
          .map(
            (item) =>
              `<div><span>${item}</span> <button onclick="pick('${item}')">${addLabel}</button></div>`,
          )
          .join("");
        res.end(
          page(`<h1>Catalogue</h1><span id="picked">picked: none</span>${rows}
            <script>function pick(x){
              document.getElementById('picked').textContent='picked: '+x;
              fetch('/picked/'+encodeURIComponent(x));
            }</script>`),
        );
        return;
      }
      case "/broken":
        res.end(page(`<h1>Broken</h1><script>console.error("TypeError: totally broken")</script>`));
        return;
      case "/login":
        res.end(
          page(`<h1>Sign in</h1>
            <label for="u">Username</label><input id="u" name="user-name" type="text">
            <label for="p">Password</label><input id="p" name="password" type="password">
            <button id="go" onclick="location.href='/inventory'">Log in</button>`),
        );
        return;
      case "/logout":
        res.end(page(`<h1>Bye</h1>`));
        return;
      default:
        res.end(page(`<h1>Fixture Shop</h1><a href="/inventory">Enter the shop</a>`));
    }
  });

  await new Promise<void>((resolve) => server.listen(fixedPort, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setAddLabel: (label: string) => {
      addLabel = label;
    },
    lastPicked: () => picked,
    setCatalogue: (items: string[]) => {
      catalogue = items;
      picked = undefined;
    },
  };
}
