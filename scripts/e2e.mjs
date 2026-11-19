// Behavioral checks against a RUNNING dashboard (default http://localhost:3000).
// Usage: npm start &  then  node scripts/e2e.mjs
// Requires: npm i -D playwright  &&  npx playwright install chromium
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1. Load all 120 rows in a fresh isolated demo, preserving shared data.
await page.goto(`${BASE}/?view=table`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "Start isolated demo" }).click();
await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length === 120);
let rows = await page.locator("tbody tr").count();
ok("dense load renders all 120 rows", rows === 120, `got ${rows}`);
ok("isolated demo is visibly labeled as simulated", await page.getByText("Isolated demo · Simulated data", { exact: true }).isVisible());
ok("summary shows spend", /\$[0-9]/.test(await page.locator("header").innerText()));

// 2. Risk order: first visible row is FAILED
const firstStatus = await page.locator("tbody tr:first-child td:first-child").innerText();
ok("risk-first ordering puts FAILED on top", /failed/i.test(firstStatus), firstStatus);

// 3. NL filter compiles and narrows the table
await page.fill('input[aria-label="Natural language filter"]', "everyone stuck on step 4 over 20 min");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 15000 });
await page.waitForTimeout(600);
const nlCount = await page.locator("tbody tr").count();
ok("NL filter narrows results", nlCount > 0 && nlCount < 120, `got ${nlCount}`);
await page.click("text=Clear filter");
await page.waitForTimeout(800);

// A delayed fetch may still resolve after cancellation. Release it after
// clearing an applied filter and make sure it cannot restore stale state.
const nlInput = page.getByRole("textbox", { name: "Natural language filter" });
await nlInput.fill("failed");
await nlInput.press("Enter");
await page.getByRole("button", { name: "Clear filter", exact: true }).waitFor();
await page.evaluate(() => {
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    if (input !== "/api/nl-filter" || JSON.parse(init?.body ?? "{}").text !== "ready") {
      return originalFetch(input, init);
    }
    return new Promise((resolve) => {
      window.releaseDelayedFilter = () => {
        window.fetch = originalFetch;
        resolve(Response.json({ ok: true, filter: { states: ["ready"] }, description: ["state is ready"], source: "local-parser" }));
        return init.signal?.aborted;
      };
    });
  };
});
await nlInput.fill("ready");
await nlInput.press("Enter");
await page.waitForFunction(() => Boolean(window.releaseDelayedFilter));
await page.getByRole("button", { name: "Clear filter", exact: true }).click();
ok("clear aborts the pending NL request", await page.evaluate(() => window.releaseDelayedFilter()));
await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length === 120);
ok("a delayed NL response cannot restore the cleared filter", !await page.getByRole("button", { name: "Clear filter", exact: true }).count());

// 3b. Cross-category "or" must NOT be silently ANDed: a warning shows instead
await page.fill('input[aria-label="Natural language filter"]', "failed or stuck under 40%");
await page.keyboard.press("Enter");
await page.waitForSelector('p.note-warn[role="alert"]', { timeout: 8000 });
const orMsg = await page.locator('p.note-warn[role="alert"]').first().innerText();
ok('cross-category "or" warns instead of silently changing intent', /one at a time|AND/.test(orMsg), orMsg.slice(0, 80));
ok('rejected OR query leaves table unchanged', (await page.locator("tbody tr").count()) >= 100);
// the alert above may be the nl notice; ensure no stale error banner confusion
await page.fill('input[aria-label="Natural language filter"]', "");
await page.keyboard.press("Escape");

// 3c. Bare-dollar phrasing compiles to a spend filter, labeled by source
await page.fill('input[aria-label="Natural language filter"]', "environments over $5");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 8000 });
await page.waitForTimeout(700);
ok('bare "$" phrasing compiles to spend filter', await page.locator("text=compiled by the offline compiler").isVisible());
const spendCount = await page.locator("tbody tr").count();
ok("spend filter narrows table", spendCount > 0 && spendCount < 120, `got ${spendCount}`);
const spendCells = await page.locator("tbody tr td:nth-child(5)").allInnerTexts();
ok("spend filter rows all >= $5", spendCells.every((s) => parseFloat(s.replace("$", "")) >= 5), spendCells[0]);
await page.click("text=Clear filter");
await page.waitForTimeout(600);

// 3e. Superlative spend question compiles to a descending spend sort, not an invented threshold
await page.fill('input[aria-label="Natural language filter"]', "who is costing the most");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 8000 });
await page.waitForTimeout(700);
ok("superlative spend query compiled offline", await page.locator("text=compiled by the offline compiler").isVisible());
ok("sort control preset to spend", (await page.locator('select[aria-label="Sort by"]').inputValue()) === "spend");
const sortedSpendCells = await page.locator("tbody tr td:nth-child(5)").allInnerTexts();
const sortedSpends = sortedSpendCells.map((s) => parseFloat(s.replace("$", "")));
ok("rows sorted by spend descending", sortedSpends.length >= 100 && sortedSpends.every((v, i) => i === 0 || sortedSpends[i - 1] >= v), `${sortedSpends[0]} ... ${sortedSpends[sortedSpends.length - 1]}`);
await page.click("text=Clear filter");
await page.selectOption('select[aria-label="Sort by"]', "risk");
await page.waitForTimeout(600);

// 3d. Manual search merges over an applied NL filter (not ignored)
await page.fill('input[aria-label="Natural language filter"]', "failed");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 8000 });
await page.waitForTimeout(800);
const failedOnly = await page.locator("tbody tr").count();
const firstName = (await page.locator("tbody tr:first-child td:nth-child(2) div:first-child").innerText()).split(" ")[0];
await page.fill('input[aria-label="Search learner"]', firstName);
await page.waitForTimeout(900);
const merged = await page.locator("tbody tr").count();
ok("manual search merges over NL filter", merged >= 1 && merged < failedOnly, `${merged} vs ${failedOnly}`);
ok("merge is labeled", await page.locator("text=combined with your manual filters").isVisible());
await page.fill('input[aria-label="Search learner"]', "");
await page.click("text=Clear filter");
await page.waitForTimeout(700);

// 4. Manual state filter: only FAILED rows shown
await page.click('button:has-text("FAILED")');
await page.waitForTimeout(1200);
const failedRows = await page.locator("tbody tr").count();
const allFailed = await page.locator("tbody tr td:first-child").allInnerTexts();
ok("failed filter shows only FAILED rows", failedRows > 0 && allFailed.every((s) => /failed/i.test(s)));

// 5. Reprovision mutates state and the table reflects it
const targetId = await page.locator("tbody tr:first-child td:nth-child(2) span.font-mono").innerText();
await page.click("tbody tr:first-child >> text=Reprovision");
await page.waitForTimeout(5000);
const stillThere = await page.locator(`tbody tr:has-text("${targetId.trim()}")`).count();
ok("reprovision removes env from failed list", stillThere === 0, `${targetId} still listed`);
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
const reprovisioned = page.locator(`tbody tr[data-env-id="${targetId.trim()}"]`);
await reprovisioned.waitFor();
ok("reloading this tab keeps the isolated demo action", !/failed/i.test(await reprovisioned.locator("td").first().innerText()));

// 6. Keyboard: "/" focuses the NL filter; arrows move into the table
await page.keyboard.press("/");
const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
ok('"/" focuses the filter box', focused === "Natural language filter", String(focused));
await page.keyboard.press("Escape");
await page.keyboard.press("ArrowDown");
const rowFocused = await page.evaluate(() => document.activeElement?.tagName === "TR");
ok("arrow key focuses a table row", rowFocused);

// 7. Empty state and clear
await page.fill('input[aria-label="Search learner"]', "zzz-no-such-learner");
await page.waitForTimeout(900);
ok("empty state appears", await page.locator("text=No environments match these filters.").isVisible());
await page.click("text=Clear all filters");
await page.waitForTimeout(900);
rows = await page.locator("tbody tr").count();
ok("clear filters restores rows", rows >= 100, `got ${rows}`);

// 8. Error state: sever the API, banner appears with retry
await page.context().route("**/api/**", (route) => route.abort());
await page.waitForTimeout(5200); // at least one failed poll
ok("error banner on API failure", await page.locator("text=Live data unavailable").isVisible());
await page.context().unroute("**/api/**");
await page.click("text=Retry now");
await page.waitForTimeout(1500);
ok("retry recovers live data", !(await page.locator("text=Live data unavailable").isVisible()));

// 9. Loading skeleton on cold load with a slow API
const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page2.context().route("**/api/**", async (route) => {
  await new Promise((r) => setTimeout(r, 1500));
  await route.continue();
});
await page2.goto(BASE, { waitUntil: "domcontentloaded" });
const skeletons = await page2.locator(".skeleton, .room-loading").count();
ok("loading skeleton shows while waiting", skeletons > 0, `got ${skeletons}`);
await page2.close();

// 10. Mobile: no page-level horizontal overflow; table scrolls internally
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(`${BASE}/?view=table`, { waitUntil: "domcontentloaded" });
await mob.waitForSelector("tbody tr td", { timeout: 20000 });
await mob.waitForTimeout(1500);
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("no page-level horizontal overflow at 390px", overflow <= 2, `overflow ${overflow}px`);
const bandWidth = await mob.evaluate(() => {
  const band = document.querySelector(".command-band");
  return band ? band.getBoundingClientRect().width : 0;
});
ok("mobile command band stacks full-width above table", bandWidth >= 350, `band ${bandWidth}px`);
await mob.close();

// 11. Rows and summary come from one snapshot: counts always agree
const sess = await (await fetch(`${BASE}/api/session`)).json();
const fJson = await (await fetch(`${BASE}/api/environments?states=failed`)).json();
ok("summary failures match filtered failed rows in the same snapshot", fJson.filtered === fJson.summary.byState.failed && fJson.summary.failures === fJson.filtered && sess.failures === sess.byState.failed);
const eJson = await (await fetch(`${BASE}/api/environments`)).json();
ok("environments response embeds the session summary", typeof eJson.summary?.estimatedSpend === "number");

// 12. Negation abstains instead of inverting the filter
await page.fill('input[aria-label="Natural language filter"]', "not failed");
await page.keyboard.press("Enter");
await page.waitForSelector('p.note-warn[role="alert"]', { timeout: 8000 });
const negMsg = await page.locator('p.note-warn[role="alert"]').first().innerText();
ok("negation abstains with guidance", /negation/i.test(negMsg), negMsg.slice(0, 90));
await page.fill('input[aria-label="Natural language filter"]', "");
await page.keyboard.press("Escape");

// 13. Name + state clauses combine instead of dropping the name
const combo = await (await fetch(`${BASE}/api/nl-filter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "failed learner named Priya" }) })).json();
ok("NL combines name + state", combo.ok && combo.filter.q === "Priya" && combo.filter.states?.includes("failed"), JSON.stringify(combo.filter));

// 14. "under 25%" excludes rows at exactly 25%
const u = await (await fetch(`${BASE}/api/nl-filter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "under 25%" }) })).json();
ok('"under 25%" compiles exclusive', u.ok && u.filter.maxProgressExclusive === true, JSON.stringify(u.filter));
const uRows = (await (await fetch(`${BASE}/api/environments?maxProgressPct=25&maxProgressExclusive=1`)).json()).environments;
ok("exclusive bound excludes exactly-25% rows", uRows.length > 0 && uRows.every((r) => r.progressPct < 25), `${uRows.length} rows`);

// 15. Advanced manual filters work without the NL feature
await page.click('button:has-text("More filters")');
await page.locator('label:has-text("Stuck 20m+ only") input').check();
await page.waitForTimeout(1500);
const stuckStatuses = await page.locator("tbody tr td:first-child").allInnerTexts();
ok("advanced stuck filter shows only STUCK rows", stuckStatuses.length > 0 && stuckStatuses.every((s) => /stuck/i.test(s)), stuckStatuses.slice(0, 3).join(","));
await page.click('button:has-text("Reset")');
await page.click('button:has-text("More filters")');
await page.waitForTimeout(900);

// 16. "r" reprovisions the focused row (by stable id, not stale index)
await page.click('button:has-text("FAILED")');
await page.waitForTimeout(1200);
const focusId = (await page.locator("tbody tr:first-child td:nth-child(2) span.font-mono").innerText()).trim();
await page.locator("tbody tr:first-child").focus();
await page.keyboard.press("r");
await page.waitForTimeout(5000);
ok('"r" reprovisions the focused row', (await page.locator(`tbody tr:has-text("${focusId}")`).count()) === 0, `${focusId} still listed`);
await page.click('button:has-text("FAILED")');
await page.waitForTimeout(900);

// 17. Reprovision on a non-failed env is a visible no-op, not an error
const readyId = await (async () => {
  const j = await (await fetch(`${BASE}/api/environments?states=ready`)).json();
  return j.environments[0]?.id;
})();
if (readyId) {
  const rp = await (await fetch(`${BASE}/api/environments/${readyId}/reprovision`, { method: "POST" })).json();
  ok("reprovision on ready env is a no-op echo", rp.ok === true && rp.environment.state === "ready", JSON.stringify(rp.environment?.state));
}

// 18. Progress semantics via API: no in_use env displays 100%
const allEnv = (await (await fetch(`${BASE}/api/environments`)).json()).environments;
const inUse100 = allEnv.filter((r) => r.state === "in_use" && r.progressPct >= 100);
ok("no in_use env shows 100% progress", inUse100.length === 0, `${inUse100.length}`);

// Optional browser pass against the local HTTP mock provider.
if (process.env.MOCK_MODEL === "1") {
  await nlInput.fill("learners who barely made any progress");
  await nlInput.press("Enter");
  const confirmation = page.getByRole("button", { name: "Apply suggested filter" });
  await confirmation.waitFor();
  ok("model suggestion leaves all 120 rows until confirmed", await page.locator("tbody tr[data-env-id]").count() === 120);
  await confirmation.click();
  await page.getByText("compiled by the AI model, confirmed by you", { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length < 120);
  ok("confirming the model suggestion narrows results", await page.locator("tbody tr[data-env-id]").count() > 0);
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await nlInput.fill("learners who have barely progressed");
  await nlInput.press("Enter");
  await page.getByRole("alert").filter({ hasText: "The optional model could not suggest" }).waitFor();
  await page.locator('.chip[data-st="failed"]').click();
  await page.waitForFunction(() => !document.querySelector('tbody tr[data-st]:not([data-st="failed"])'));
  ok("manual Failed filter still works after optional provider failure", await page.locator("tbody tr[data-env-id]").count() > 0);
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
