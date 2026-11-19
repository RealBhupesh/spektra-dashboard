// Deterministic evidence for the visibility-pause behavior:
//   1. A page opened directly into a HIDDEN tab makes zero poll requests -
//      no initial fetch, no interval - until it first becomes visible.
//   2. Becoming visible triggers an immediate poll (data loads without
//      waiting a full interval).
//   3. Going hidden again stops the interval; becoming visible again polls
//      immediately once more.
// document.hidden/visibilityState are stubbed via addInitScript BEFORE any
// page script runs, so the app genuinely believes the tab is hidden.
// Usage: npm start &  then  BASE_URL=http://localhost:3100 node scripts/e2e-hidden-mount.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  let hidden = true; // mount hidden; the test flips this explicitly
  window.__setHidden = (v) => {
    hidden = Boolean(v);
    document.dispatchEvent(new Event("visibilitychange"));
  };
  Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
  Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
});
const page = await context.newPage();

let pollRequests = 0;
page.on("request", (req) => {
  if (req.url().includes("/api/environments?")) pollRequests++;
});

await page.goto(`${BASE}/?view=table`, { waitUntil: "domcontentloaded" });
// POLL_MS is 4s; 5.5s hidden would show at least an initial fetch plus one
// interval fire under the old behavior.
await page.waitForTimeout(5500);
ok("hidden at mount: zero poll requests (no initial fetch, no interval)", pollRequests === 0, `got ${pollRequests}`);
ok("hidden at mount: no rows rendered yet", (await page.locator("tbody tr[data-env-id]").count()) === 0);

// Become visible: an immediate poll must follow well inside one interval.
await page.evaluate(() => window.__setHidden(false));
const t0 = Date.now();
await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length === 120, null, { timeout: 10000 });
ok("becoming visible polls immediately and loads all rows", true);
ok("first poll landed well inside one 4s interval", Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
ok("exactly one poll request for the first visibility", pollRequests === 1, `got ${pollRequests}`);

// Hidden again: the interval stops.
await page.evaluate(() => window.__setHidden(true));
const before = pollRequests;
await page.waitForTimeout(5500);
ok("hidden again: interval stops (zero further requests)", pollRequests === before, `${pollRequests - before} new`);

// Visible once more: immediate poll resumes the loop.
await page.evaluate(() => window.__setHidden(false));
ok("visible again: immediate poll resumes", await (async () => {
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) {
    if (pollRequests > before) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})());

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
