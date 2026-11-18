// Local axe-core audit of the dashboard's key states. Dev-only; axe-core is
// installed with --no-save and never shipped.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const axeSrc = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/?view=table", { waitUntil: "networkidle" });
await page.waitForSelector(".ops-table tbody tr", { timeout: 15000 });
await page.waitForTimeout(1200);

async function audit(label) {
  await page.evaluate(axeSrc);
  const res = await page.evaluate(async () => await axe.run(document, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: true } },
  }));
  const v = res.violations.map((x) => ({
    id: x.id,
    impact: x.impact,
    nodes: x.nodes.length,
    first: x.nodes[0]?.target?.join(" ") ?? "",
    msg: x.nodes[0]?.failureSummary?.split("\n")[0] ?? "",
  }));
  console.log(`## ${label}: ${v.length} violation types`);
  for (const x of v) console.log(`- [${x.impact}] ${x.id} (${x.nodes} nodes) ${x.first} :: ${x.msg}`);
}

await audit("dense default");

// State 2: a row selected (detail strip open)
await page.click(".ops-table tbody tr");
await page.waitForTimeout(400);
await audit("detail panel open");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// State 3: failed-only filter
await page.click('.chip:has-text("FAILED")');
await page.waitForTimeout(800);
await audit("failed filter");

// State 4: NL filter applied
await page.click('.chip:has-text("FAILED")'); // toggle off
await page.fill('input[aria-label="Natural language filter"]', "everyone stuck on step 4 over 20 min");
await page.click('button:has-text("Apply")');
await page.waitForTimeout(1200);
await audit("nl filter applied");

// State 5: the floor map (default view), a seat open
await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForSelector(".seat[data-env-id]", { timeout: 15000 });
await page.waitForTimeout(800);
await audit("floor map");
await page.click('.seat[data-st="failed"]');
await page.waitForTimeout(400);
await audit("floor map, seat open");

await browser.close();
