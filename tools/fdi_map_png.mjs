// Dev-only: exports the FDI map as images for social posts and for the page's link preview.
//
//   node tools/fdi_map_png.mjs
//
// writes  site/assets/fdi-map-post.png  2400 x 3000 (a 1200 x 1500 layout at 2x), for LinkedIn and other posts
//         site/assets/fdi-map-og.png    1200 x 630, the page's og:image (link previews crop to about 1.91:1)
//
// Run it after  python tools/fdi_map.py  so the images show the same data as the page. No npm packages: it uses
// Node 22+ built-ins (http, fetch, WebSocket) and a Chromium browser already on the machine (Edge or Chrome).
// Set BROWSER=/path/to/chrome if it is not found. The browser runs headless with a throwaway profile.

import { createServer } from "node:http";
import { readFile, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
const BROWSERS = [process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"].filter(Boolean);

// Layouts applied on top of the live page, so the images always use the page's own fonts, colours and data.
const SHARED_CSS = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  header.site, footer.site, .crumbs, .fdi-views, .skip-link, #fdi-table-view, #method, .fdi-asof, .fdi-panel,
  section .head, .fdi-filters { display: none !important; }
  html, body { overflow: hidden; }
  body { margin: 0; }
  main { display: flex; flex-direction: column; }
  .wrap { width: auto; margin: 0; }
  .page-hero { order: 0; padding: 0; }
  .page-hero::after { display: none; }
  section.block { padding: 0 !important; }
  .share-foot { font: 15px/1.4 var(--sans); color: var(--muted); max-width: none; }
`;
const LAYOUTS = {
  post: { width: 1200, height: 1500, scale: 2, file: "fdi-map-post.png", css: SHARED_CSS + `
    body { width: 1200px; height: 1500px; background: var(--paper); }
    main { height: 1500px; }
    .page-hero { padding: 52px 56px 36px; gap: 14px; }
    .page-hero h1 { font-size: 56px; max-width: none; }
    .page-hero .fdi-counts { font-size: 19px; max-width: 1000px; }
    #map { order: 1; flex: 1; min-height: 0; display: flex; padding: 22px 56px 0 !important; }
    #map > .wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    #fdi-map-view { flex: 1; min-height: 0; display: flex; }
    .fdi-map-scroll { flex: 1; overflow: hidden; display: flex; justify-content: center; padding: 10px; box-shadow: none; }
    .fdi-svg { min-width: 0; width: 100%; height: 100%; }
    .fdi-legend { margin-bottom: 12px; font-size: 15px; }
    section[aria-labelledby="fdi-figures-title"] { order: 2; padding: 20px 56px 0 !important; }
    .fdi-figures { grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .fdi-figure { padding: 20px 22px; gap: 6px; box-shadow: none; }
    .fdi-figure::before { display: none; }
    .fdi-figure .fdi-big { font-size: 38px; }
    .fdi-figure p { font-size: 15px; line-height: 1.45; }
    .share-foot { order: 3; padding: 16px 56px 0; }` },
  og: { width: 1200, height: 630, scale: 1, file: "fdi-map-og.png", css: SHARED_CSS + `
    body { width: 1200px; height: 630px; background: var(--night); }
    main { height: 630px; background: var(--aurora), var(--night); }
    #map { display: none !important; }
    .page-hero { padding: 48px 60px 26px; gap: 14px; }
    .page-hero::before { display: none; }
    .page-hero h1 { font-size: 50px; max-width: 1000px; }
    .page-hero .fdi-counts { font-size: 18px; max-width: 1000px; }
    section[aria-labelledby="fdi-figures-title"] { order: 2; padding: 0 60px !important; }
    .fdi-figures { grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .fdi-figure { padding: 16px 20px; gap: 4px; background: var(--glass); border-color: var(--glass-line); box-shadow: none; }
    .fdi-figure::before { display: none; }
    .fdi-figure .fdi-big { font-size: 34px; color: var(--on-dark); }
    .fdi-figure p { font-size: 14px; line-height: 1.4; color: var(--night-muted); }
    .share-foot { order: 3; padding: 16px 60px 0; color: var(--night-muted); }` },
};

function serve() {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(SITE, rel);
    if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body); }
    catch { res.writeHead(404).end(); }
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(profile) {
  const exe = BROWSERS.find(p => existsSync(p));
  if (!exe) throw new Error("No Edge or Chrome found. Set BROWSER to the path of a Chromium browser.");
  const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = (await readFile(portFile, "utf8")).split("\n")[0].trim();
  return { proc, port };
}

async function cdp(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener("message", m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) events.push(d); });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, events, close: () => ws.close() };
}

async function main() {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/fdi-map.html`;
  const profile = await mkdtemp(path.join(tmpdir(), "fdi-map-png-"));
  const { proc, port } = await launch(profile);
  try {
    for (const [name, L] of Object.entries(LAYOUTS)) {
      const { send, events, close } = await cdp(port);
      await send("Page.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: L.width, height: L.height, deviceScaleFactor: L.scale, mobile: false });
      await send("Page.navigate", { url });
      for (let i = 0; i < 100 && !events.some(e => e.method === "Page.loadEventFired"); i++) await sleep(100);
      const r = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
        const style = document.createElement("style"); style.textContent = ${JSON.stringify(L.css)}; document.head.append(style);
        const asof = document.querySelector(".fdi-asof time");
        const foot = document.createElement("p"); foot.className = "share-foot";
        foot.textContent = "Research and map: ArchangX · archangx.com/fdi-map.html · Public sources as of " + (asof ? asof.textContent : "")
          + " · Not exhaustive, corrections welcome";
        document.querySelector("main").append(foot);
        return !!document.querySelector(".fdi-svg");
      })()` });
      if (!r.result?.result?.value) throw new Error("fdi-map.html has no map: run  python tools/fdi_map.py  first.");
      await sleep(500);
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: L.width, height: L.height, scale: 1 } });
      const out = path.join(SITE, "assets", L.file);
      await writeFile(out, Buffer.from(shot.result.data, "base64"));
      console.log(`wrote site/assets/${L.file}  ${L.width * L.scale} x ${L.height * L.scale}  ${Math.round((await stat(out)).size / 1024)} KB`);
      await send("Page.close").catch(() => {}); close();
    }
  } finally {
    proc.kill(); server.close();
    await sleep(500); await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(e => { console.error("error: " + e.message); process.exit(1); });
