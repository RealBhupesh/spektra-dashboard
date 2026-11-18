// Regenerates the seven packaged screenshots against the running app.
// Usage: npm start &  then  node scripts/shoot-stills.mjs
import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".ops-table tbody tr", { timeout: 15000 });
await wait(1500);
await page.screenshot({ path: "screenshots/shot-11-redesign-dense.png" });

// Detail strip: select a row, bring the strip fully into view
await page.click(".ops-table tbody tr");
await wait(500);
await page.locator("section", { hasText: "Reprovision environment" }).first().scrollIntoViewIfNeeded();
await wait(400);
await page.screenshot({ path: "screenshots/shot-12-redesign-detail.png" });
await page.keyboard.press("Escape");

// NL filter (stuck cohort visible on a fresh seed)
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".ops-table tbody tr", { timeout: 15000 });
await page.fill('input[aria-label="Natural language filter"]', "everyone stuck over 20 minutes");
await page.keyboard.press("Enter");
await page.waitForSelector("text=Filter:", { timeout: 8000 });
await wait(1200);
await page.screenshot({ path: "screenshots/shot-14-redesign-nl-filter.png" });
await page.click("text=Clear filter");
await wait(800);

// Failed-only
await page.click('button:has-text("FAILED")');
await wait(1000);
await page.screenshot({ path: "screenshots/shot-15-redesign-failed.png" });
await page.click('button:has-text("FAILED")');
await wait(800);

// Spend sort
await page.selectOption("select", "spend");
await wait(1000);
await page.screenshot({ path: "screenshots/shot-16-redesign-spend-sort.png" });
await page.selectOption("select", "risk");
await wait(500);

// Advanced "More filters" panel, with one control engaged
await page.click('button:has-text("More filters")');
await wait(400);
await page.click('label:has-text("Stuck 20m+ only")');
await wait(1200);
await page.screenshot({ path: "screenshots/shot-18-redesign-more-filters.png" });
await page.click('button:has-text("Reset")');
await page.click('button:has-text("More filters")');
await wait(600);

// Empty state
await page.fill('input[placeholder="Search learner"]', "nobody-by-this-name");
await wait(1000);
await page.screenshot({ path: "screenshots/shot-17-redesign-empty.png" });

// Mobile
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(BASE, { waitUntil: "networkidle" });
await mob.waitForSelector(".ops-table tbody tr", { timeout: 15000 });
await mob.waitForTimeout(1200);
await mob.screenshot({ path: "screenshots/shot-13-redesign-mobile.png" });

await browser.close();
console.log("STILLS DONE");
