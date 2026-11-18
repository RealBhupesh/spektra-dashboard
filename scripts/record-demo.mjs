// Records a ~75s demo video of the dashboard under live load:
// dense 120-row table drifting, NL filter, manual filter, reprovision.
// Usage: npm start &  then  node scripts/record-demo.mjs
// Requires: playwright (video is bundled with chromium).
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "recordings";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
});
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

// 1. Dense live view, drifting (0-20s)
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("tbody tr", { timeout: 15000 });
await wait(16000);

// 2. NL filter (20-35s). "stuck over 20 minutes" matches the seeded stuck
// cohort (lib/seed.ts pre-ages ~22% of in-use envs 20-65 min into a step),
// so the stuck path is guaranteed visible on a fresh session.
await page.fill('input[aria-label="Natural language filter"]', "everyone stuck over 20 minutes");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 8000 });
await wait(11000);
await page.click("text=Clear filter");
await wait(2000);

// 3. Manual advanced filters via the More filters panel (~30-38s)
await page.click('button:has-text("More filters")');
await wait(500);
await page.click('label:has-text("Stuck 20m+ only")');
await wait(5000);
await page.click('button:has-text("Reset")');
await wait(1000);
await page.click('button:has-text("More filters")');
await wait(1000);

// 4. Failed-only via manual chip, then reprovision the top failure (38-62s)
await page.click('button:has-text("FAILED")');
await wait(5000);
const first = page.locator("tbody tr:first-child");
await first.locator("text=Reprovision").click();
await wait(12000);
await page.click('button:has-text("FAILED")');
await wait(2000);

// 5. Superlative spend sort, then back to live view (62-75s)
await page.fill('input[aria-label="Natural language filter"]', "who is costing the most");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 8000 });
await wait(8000);
await page.click("text=Clear filter");
await wait(3000);

await ctx.close(); // finalizes the video
await browser.close();
const v = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm")).sort();
console.log("VIDEO:", OUT + "/" + v[v.length - 1]);
