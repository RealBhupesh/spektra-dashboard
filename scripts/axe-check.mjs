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
  const css = readFileSync("app/globals.css", "utf8");
  const map = readFileSync("components/floor-map.tsx", "utf8");
  const cutoff = Number(map.match(/style\["--ramp-text"\] = pct >= (\d+)/)?.[1]);
  if (!Number.isFinite(cutoff)) throw new Error("Seat ramp cutoff missing");
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
      if (!/^#[\da-f]{6}$/i.test(hex ?? "")) throw new Error(`Unresolved seat color ${color}`);
      return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    };
    const verify = (label, fg, bg) => {
      const ratio = contrast(fg, bg);
      minimum = Math.min(minimum, ratio);
      count++;
      if (ratio < 4.5) throw new Error(`${selector} ${label}: ${ratio.toFixed(2)}:1`);
    };
    const start = rgb("var(--seat-ramp-start)");
    const end = rgb("var(--seat-ramp-end)");
    const dim = rule('.seat[data-mode][data-dim="true"]');
    for (const mode of ["status", "spend", "progress"]) {
      verify(`${mode} filtered`, rgb(value(dim, "--txt")), rgb(value(dim, "--fill")));
      if (mode === "status") {
        for (const state of ["in_use", "failed", "stuck", "ready", "provisioning", "deprovisioned"]) {
          const status = rule(`.seat[data-mode="status"][data-st="${state}"]`);
          verify(state, rgb(value(status, "--txt")), rgb(value(status, "--fill") ?? "var(--surface)"));
        }
      } else {
        for (let pct = 0; pct <= 100; pct++) {
          const fg = rgb(pct >= cutoff ? "#ffffff" : "var(--seat-ramp-low-text)");
          const bg = start.map((channel, index) => Math.round((channel * (100 - pct) + end[index] * pct) / 100));
          verify(`${mode} ${pct}%`, fg, bg);
        }
      }
    }
    verify("row label", rgb(value(rule(".row-label"), "color")), rgb("var(--surface)"));
  }
  console.log(`${count} palette pairs passed at 4.5:1 or higher (minimum ${minimum.toFixed(2)}:1).`);
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
        const colors = await page.locator(".seat[data-env-id]").evaluateAll((nodes) => {
          const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
          const pixel = (color) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
          };
          return nodes.map((node) => {
            const { color, backgroundColor } = getComputedStyle(node);
            return [pixel(color), pixel(backgroundColor)];
          });
        });
        const minimum = Math.min(...colors.map(([fg, bg]) => contrast(fg, bg)));
        console.log(`  ${colors.length} computed seat color pairs, minimum ${minimum.toFixed(2)}:1`);
        if (colors.length !== 120 || minimum < 4.5) failures++;
      };
      await page.goto(`${base}/?view=table`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Start isolated demo" }).click();
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
        await page.waitForFunction(() => document.querySelectorAll(".seat[data-env-id]").length === 120 && !document.querySelector(".seat[data-dim]"));
        await audit(`floor ${mode}`, true);
        await failed.click();
        await page.locator('.seat[data-dim="true"]').first().waitFor();
        await audit(`floor ${mode} filtered`, true);
        await failed.click();
      }
      await page.getByRole("button", { name: "Status", exact: true }).click();
      await page.locator('.seat[data-st="failed"]').first().click();
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
