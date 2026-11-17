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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1. Loads with the full dense dataset
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("tbody tr td", { timeout: 20000 });
await page.waitForTimeout(2500); // let a poll land
let rows = await page.locator("tbody tr").count();
ok("dense load renders ~120 rows", rows >= 100, `got ${rows}`);
ok("summary shows spend", /\$[0-9]/.test(await page.locator("header").innerText()));

// 2. Risk order: first visible row is FAILED
const firstStatus = await page.locator("tbody tr:first-child td:first-child").innerText();
ok("risk-first ordering puts FAILED on top", /FAILED/.test(firstStatus), firstStatus);

// 3. NL filter compiles and narrows the table
await page.fill('input[aria-label="Natural language filter"]', "everyone stuck on step 4 over 20 min");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 15000 });
await page.waitForTimeout(600);
const nlCount = await page.locator("tbody tr").count();
ok("NL filter narrows results", nlCount > 0 && nlCount < 120, `got ${nlCount}`);
await page.click("text=Clear filter");
await page.waitForTimeout(800);

// 3b. Cross-category "or" must NOT be silently ANDed: a warning shows instead
await page.fill('input[aria-label="Natural language filter"]', "failed or stuck under 40%");
await page.keyboard.press("Enter");
await page.waitForSelector('[role="alert"]', { timeout: 8000 });
const orMsg = await page.locator('[role="alert"]').first().innerText();
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
ok("failed filter shows only FAILED rows", failedRows > 0 && allFailed.every((s) => /FAILED/.test(s)));

// 5. Reprovision mutates state and the table reflects it
const targetId = await page.locator("tbody tr:first-child td:nth-child(2) span.font-mono").innerText();
await page.click("tbody tr:first-child >> text=Reprovision");
await page.waitForTimeout(5000);
const stillThere = await page.locator(`tbody tr:has-text("${targetId.trim()}")`).count();
ok("reprovision removes env from failed list", stillThere === 0, `${targetId} still listed`);

// 6. Keyboard: "/" focuses the NL filter; arrows move into the table
await page.keyboard.press("/");
const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
ok('"/" focuses the AI filter', focused === "Natural language filter", String(focused));
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
const skeletons = await page2.locator(".skeleton").count();
ok("loading skeleton shows while waiting", skeletons > 0, `got ${skeletons}`);
await page2.close();

// 10. Mobile: no page-level horizontal overflow; table scrolls internally
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: "domcontentloaded" });
await mob.waitForSelector("tbody tr td", { timeout: 20000 });
await mob.waitForTimeout(1500);
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("no page-level horizontal overflow at 390px", overflow <= 2, `overflow ${overflow}px`);
const railWidth = await mob.evaluate(() => {
  const aside = document.querySelector("aside");
  return aside ? aside.getBoundingClientRect().width : 0;
});
ok("mobile rail stacks full-width above table", railWidth >= 350, `rail ${railWidth}px`);
await mob.screenshot({ path: "screenshots/spektra-shot-8-mobile.png", fullPage: false });
await mob.close();

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
