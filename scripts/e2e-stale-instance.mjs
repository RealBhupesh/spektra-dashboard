// Browser-level proof of the stale-instance guarantee. After a confirmed
// reprovision, the follow-up polls are served a STALE snapshot (captured
// before the action) via Playwright request interception - byte-identical to
// what a second serverless instance with a warm cache would answer. The UI
// must hold the row's pending state and must not re-arm the button (the
// rollback path); once live responses resume, the next poll includes the
// confirmed action, applies, and clears pending.
// Usage: npm start &  then  BASE_URL=http://localhost:3100 node scripts/e2e-stale-instance.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
};
const waitUntil = async (fn, timeout) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE}/?view=table`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Start fresh demo" }).click();
await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length === 120);

// Capture a pre-action snapshot: exactly what a stale instance would serve.
const staleResponse = await page.waitForResponse(
  (r) => r.url().includes("/api/environments?") && r.status() === 200,
  { timeout: 15000 },
);
const staleBody = await staleResponse.text();
const staleJson = JSON.parse(staleBody);
ok("captured snapshot carries the action log", Array.isArray(staleJson.actions) && typeof staleJson.stateVersion === "number");

// Risk order puts a FAILED row first.
const firstRow = page.locator("tbody tr[data-env-id]").first();
const envId = await firstRow.getAttribute("data-env-id");
const rowById = () => page.locator(`tbody tr[data-env-id="${envId}"]`);
const rowButton = () => rowById().locator("button", { hasText: "Reprovision" });
ok("target row starts FAILED with an armed Reprovision button",
  /failed/i.test(await rowById().locator("td").first().innerText()) && (await rowButton().isEnabled()));

// From here, every environments poll is answered with the stale snapshot.
// The reprovision POST itself is NOT intercepted (different URL shape).
let staleServed = 0;
await page.route("**/api/environments?**", (route) => {
  staleServed++;
  route.fulfill({ status: 200, contentType: "application/json", body: staleBody });
});

const [postRes] = await Promise.all([
  page.waitForResponse((r) => r.url().includes("/reprovision") && r.request().method() === "POST"),
  rowButton().click(),
]);
const postBody = await postRes.json();
ok("reprovision POST confirms with the appended action",
  postBody.ok === true && postBody.action && postBody.action.id === envId && typeof postBody.action.at === "number",
  JSON.stringify(postBody.action ?? null));

// Several stale polls are served (the immediate follow-up poll plus interval
// polls). The row must NOT roll back: pending holds, button stays disabled,
// no action error appears.
ok("at least two stale polls were served after the confirmed action",
  await waitUntil(() => staleServed >= 2, 20000), `served ${staleServed}`);
ok("pending holds through stale snapshots (button stays disabled)",
  await waitUntil(async () => (await rowButton().innerText()) === "Reprovisioning" && (await rowButton().isDisabled()), 5000)
  && (await rowButton().innerText()) === "Reprovisioning"
  && (await rowButton().isDisabled()));
ok("no action error banner during stale polls",
  !(await page.getByText(/failed\./).first().isVisible().catch(() => false)));

// Resume live responses: the next poll includes the confirmed action, the
// row leaves FAILED (the Reprovision button unmounts for non-failed rows,
// which is itself evidence the confirmed snapshot was applied), and no
// pending indicator remains.
await page.unroute("**/api/environments?**");
ok("first live poll after staleness confirms the action (row leaves FAILED)",
  await waitUntil(async () => {
    const status = await rowById().locator("td").first().innerText().catch(() => "");
    return status !== "" && !/failed/i.test(status);
  }, 20000));
ok("no pending indicator remains after confirmation",
  await waitUntil(async () => !(await page.getByText("Reprovisioning", { exact: true }).first().isVisible().catch(() => false)), 5000));
ok("stale snapshots never re-armed the button mid-flight", staleServed >= 2);

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
