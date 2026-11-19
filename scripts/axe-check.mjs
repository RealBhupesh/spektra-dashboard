// Browser audit of theme, view, filter and seat contrast combinations.
// --palette verifies the same seat text contrast math without a browser.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

function contrast(fg, bg) {
  const luminance = (rgb) => rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => x - y);
  return (b + 0.05) / (a + 0.05);
}

function palette() {
  // The isometric lab draws status as shape and pattern on a screen face, not
  // as text on a seat. Check what carries meaning: each status color against
  // the panel surface (3:1 for graphics) and each mark against its fill.
  const css = readFileSync("app/globals.css", "utf8");
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    if (start === -1) throw new Error(`Missing rule ${selector}`);
    return css.slice(start + selector.length + 2, css.indexOf("}", start));
  };
  const value = (block, key) => block.match(new RegExp(`${key}:\\s*([^;]+);`))?.[1];
  let count = 0;
  let minimum = Infinity;
  for (const selector of [":root", ':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
    const tokens = rule(selector);
    const rgb = (color) => {
      const token = color?.match(/^var\((--[^)]+)\)$/)?.[1];
      const hex = token ? value(tokens, token) : color;
      if (!/^#[\da-f]{6}$/i.test(hex ?? "")) throw new Error(`Unresolved color ${color}`);
      return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    };
    const verify = (label, fg, bg, min) => {
      const ratio = contrast(fg, bg);
      minimum = Math.min(minimum, ratio);
      count++;
      if (ratio < min) throw new Error(`${selector} ${label}: ${ratio.toFixed(2)}:1 (need ${min})`);
    };
    const surface = rgb("var(--surface)");
    for (const t of ["--ready", "--booting", "--line-strong", "--ink"]) verify(`${t} edge vs surface`, rgb(`var(${t})`), surface, 3);
    verify("failed mark on fill", rgb("var(--seat-failure-text)"), rgb("var(--failed)"), 3);
    verify("stuck mark on fill", rgb("#1d1300"), rgb("var(--stuck)"), 3);
    verify("finished tick on fill", rgb("var(--ink-2)"), rgb("var(--off)"), 3);
    verify("bench row label", rgb("var(--ink-2)"), surface, 4.5);
  }
  console.log(`${count} graphic/text pairs passed (minimum ${minimum.toFixed(2)}:1).`);
}

if (process.argv.includes("--palette")) {
  palette();
} else {
  const base = process.env.BASE_URL || "http://localhost:3000";
  const axeSrc = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
  const browser = await chromium.launch();
  let audits = 0;
  let failures = 0;
  try {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
      const page = await context.newPage();
      const audit = async (label, seats = false) => {
        const res = await page.evaluate(() => axe.run(document, { resultTypes: ["violations"] }));
        audits++;
        failures += res.violations.length;
        const prefix = `${colorScheme} ${label}`;
        console.log(`${prefix}: ${res.violations.length} axe violation types`);
        for (const rule of res.violations) {
          console.log(`  ${rule.id}: ${rule.nodes.length} nodes, e.g. ${rule.nodes[0]?.target?.join(" ")}`);
        }
        if (!seats) return;
        const n = await page.locator(".pc[data-env-id]").count();
        console.log(`  ${n} PCs drawn`);
        if (n !== 120) failures++;
      };
      await page.goto(`${base}/?view=table`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Start fresh demo" }).click();
      await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length === 120);
      await page.addScriptTag({ content: axeSrc });
      await audit("dense table");
      await page.locator("tbody tr[data-env-id]").first().click();
      await page.getByRole("region", { name: /^Details for/ }).waitFor();
      await audit("table detail");
      await page.keyboard.press("Escape");
      const failed = page.locator('.chip[data-st="failed"]');
      await failed.click();
      await page.waitForFunction(() => !document.querySelector('tbody tr[data-st]:not([data-st="failed"])'));
      await audit("table failed filter");
      await failed.click();
      const input = page.getByRole("textbox", { name: "Natural language filter" });
      await input.fill("everyone stuck on step 4 over 20 min");
      await input.press("Enter");
      await page.getByRole("button", { name: "Clear filter" }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length < 120);
      await audit("table NL filter");
      await page.getByRole("button", { name: "Clear filter" }).click();
      await page.getByRole("tab", { name: "Floor map" }).click();
      for (const mode of ["Status", "Spend", "Progress"]) {
        await page.getByRole("button", { name: mode, exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pc[data-env-id]").length === 120 && !document.querySelector(".pc[data-dim]"));
        await audit(`floor ${mode}`, true);
        await failed.click();
        await page.locator('.pc[data-dim="true"]').first().waitFor();
        await audit(`floor ${mode} filtered`, true);
        await failed.click();
      }
      await page.getByRole("button", { name: "Status", exact: true }).click();
      await page.locator('.pc[data-st="failed"]').first().click();
      await page.getByRole("region", { name: /^Details for/ }).waitFor();
      await audit("floor detail", true);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`${audits} states audited, ${failures} failures.`);
  process.exitCode = failures ? 1 : 0;
}
