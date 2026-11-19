// Checks for the isometric lab view, against a RUNNING dashboard.
// BASE_URL defaults to http://localhost:3000. SHOTS=dir saves screenshots.
import { chromium } from "playwright";
const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOTS = process.env.SHOTS;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${extra}`}`); };
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const browser = await chromium.launch();
const open = async (viewport, scheme = "light") => {
  const page = await browser.newPage({ viewport, colorScheme: scheme });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Start isolated demo" }).click();
  await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".pc[data-env-id]").length === 120, null, { timeout: 40000 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  return page;
};
try {
  // Desktop, all 120
  const page = await open({ width: 1440, height: 900 });
  ok("120 PCs drawn, each a labelled button", await page.evaluate(() => [...document.querySelectorAll(".pc[data-env-id]")].every((e) => e.getAttribute("role") === "button" && (e.getAttribute("aria-label") || "").length > 20)));
  const rendered = await page.evaluate(() => { const o = {}; document.querySelectorAll(".pc[data-env-id]").forEach((e) => { const s = e.getAttribute("data-st"); o[s] = (o[s] || 0) + 1; }); return o; });
  const legend = await page.evaluate(() => { const o = {}; document.querySelectorAll('.floor ~ div button[data-st]').forEach((b) => { o[b.getAttribute("data-st")] = Number(b.querySelector(".tnum")?.textContent); }); return o; });
  ok("legend counts equal rendered PCs per status", JSON.stringify(Object.entries(legend).sort()) === JSON.stringify(Object.entries(rendered).sort()), `${JSON.stringify(legend)} vs ${JSON.stringify(rendered)}`);
  ok("legend totals 120", Object.values(legend).reduce((a, b) => a + b, 0) === 120);
  const box = await page.locator('.pc[data-idx="0"]').boundingBox();
  ok("a PC target is at least 28px wide at Fit on 1440", box.width >= 28, `got ${box.width.toFixed(1)}`);
  const svgBox = await page.locator("svg.iso").boundingBox();
  const floorBox = await page.locator(".floor").boundingBox();
  ok("lab fills the panel width at Fit (no wide blank margin)", svgBox.width >= floorBox.width - 40, `${svgBox.width} vs ${floorBox.width}`);
  await shot(page, "01-desktop-fit");
  // keyboard
  await page.locator('.pc[data-idx="0"]').focus();
  await page.keyboard.press("ArrowRight");
  ok("ArrowRight moves along the bench", (await page.evaluate(() => document.activeElement?.getAttribute("data-idx"))) === "1");
  await page.keyboard.press("ArrowDown");
  ok("ArrowDown moves to next bench", (await page.evaluate(() => document.activeElement?.getAttribute("data-idx"))) === "13");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: /^Details for/ }).waitFor();
  ok("Enter opens the detail drawer", true);
  ok("hover card is gone after the drawer opens", (await page.locator('[role="tooltip"]').count()) === 0);
  await shot(page, "02-detail");
  await page.keyboard.press("Escape");
  // mouse click clears the hover card too
  await page.locator('.pc[data-st="failed"]').first().hover();
  ok("hover card shows on hover", (await page.locator('[role="tooltip"]').count()) === 1);
  await page.locator('.pc[data-st="failed"]').first().click();
  await page.getByRole("region", { name: /^Details for/ }).waitFor();
  ok("click: hover card removed once drawer opens", (await page.locator('[role="tooltip"]').count()) === 0);
  await page.keyboard.press("Escape");
  // pan / zoom navigation (viewBox based; the svg box itself never changes size)
  const vbw = async () => Number((await page.locator("svg.iso").getAttribute("viewBox")).split(" ")[2]);
  const vbx = async () => (await page.locator("svg.iso").getAttribute("viewBox")).split(" ").map(Number);
  const w0 = await vbw();
  const box0 = await page.locator("svg.iso").boundingBox();
  ok("zoom out is disabled at Fit", await page.getByRole("button", { name: "Zoom out" }).isDisabled());
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const w2 = await vbw();
  ok("two zoom-in clicks shrink the view to ~1/2.25", Math.abs(w0 / w2 - 2.25) < 0.05, `${w0} -> ${w2}`);
  const box2 = await page.locator("svg.iso").boundingBox();
  ok("zoom keeps the lab panel the same size", Math.abs(box2.width - box0.width) < 2 && Math.abs(box2.height - box0.height) < 2);
  await shot(page, "03-zoom-2x");
  // drag pans, and a drag does not open a PC
  const c = { x: box2.x + box2.width / 2, y: box2.y + box2.height / 2 };
  const before = await vbx();
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 120, c.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await vbx();
  ok("dragging pans the view", Math.abs(after[0] - before[0]) > 5 && after[2] === before[2], `${before} -> ${after}`);
  ok("dragging over a PC does not open details", (await page.getByRole("region", { name: /^Details for/ }).count()) === 0);
  // a plain click on a PC still opens it while zoomed
  await page.locator('.pc[data-st="failed"]').first().scrollIntoViewIfNeeded().catch(() => {});
  // Ctrl+wheel zooms about the cursor and does not scroll the page
  await page.mouse.move(c.x, c.y);
  const wBefore = await vbw();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  ok("Ctrl+wheel zooms in", (await vbw()) < wBefore);
  // keyboard: 0 fits, + zooms; focused PC arrows still move between PCs
  await page.locator(".pc").nth(30).focus();
  await page.keyboard.press("0");
  await page.waitForTimeout(150);
  ok("0 key returns to Fit", Math.abs((await vbw()) - w0) < 0.5);
  await page.keyboard.press("+");
  ok("+ key zooms in", (await vbw()) < w0);
  const f0 = await page.evaluate(() => document.activeElement?.getAttribute("data-idx"));
  await page.keyboard.press("ArrowRight");
  ok("arrow keys still move between focused PCs while zoomed", (await page.evaluate(() => document.activeElement?.getAttribute("data-idx"))) === String(Number(f0) + 1));
  // regression D1: a press on a PC near the lab edge must not pan the view first
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(150);
  const edgePc = async () => page.evaluate(() => {
    const s = document.querySelector("svg.iso").getBoundingClientRect();
    for (const el of document.querySelectorAll(".pc")) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dl = r.left - s.left, dr = s.right - r.right, dt = r.top - s.top, db = s.bottom - r.bottom;
      if (Math.min(dl, dr, dt, db) > 2 && Math.min(dl, dr, dt, db) < 38) return { id: el.getAttribute("data-env-id"), x: cx, y: cy };
    }
    return null;
  });
  let e1 = await edgePc();
  for (let i = 0; i < 6 && !e1; i++) {
    const sb = await page.locator("svg.iso").boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 29 * (i + 1), sb.y + sb.height / 2 + 13 * (i + 1), { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    e1 = await edgePc();
  }
  ok("found a fully visible PC within 40px of the view edge", !!e1);
  if (e1) {
    const v0 = await vbx();
    await page.mouse.click(e1.x, e1.y);
    await page.waitForTimeout(200);
    const reg = page.getByRole("region", { name: /^Details for/ });
    ok("mouse press on an edge PC opens it (no pre-click pan)", (await reg.count()) === 1);
    const v1 = await vbx();
    ok("view did not move on a pointer press", Math.abs(v1[0] - v0[0]) < 0.01 && Math.abs(v1[1] - v0[1]) < 0.01, `${v0} -> ${v1}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  // keyboard focus still reveals an off-screen PC
  await page.locator(".pc").nth(0).focus();
  const kv = await page.evaluate(() => { const s = document.querySelector("svg.iso").getBoundingClientRect(); const r = document.activeElement.getBoundingClientRect(); return r.right > s.left - 1 && r.left < s.right + 1 && r.bottom > s.top - 1 && r.top < s.bottom + 1; });
  ok("keyboard focus brings an off-screen PC into view", kv);
  // click opens a PC while zoomed
  await page.locator(".pc").nth(30).click();
  ok("click opens a PC while zoomed", (await page.getByRole("region", { name: /^Details for/ }).count()) === 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  ok("Fit restores the full view", Math.abs((await vbw()) - w0) < 0.5);
  // empty state
  await page.fill('input[aria-label="Search learner"]', "zzz-no-such-learner");
  await page.waitForTimeout(900);
  ok("empty state message", await page.locator("text=No environments match these filters.").isVisible());
  ok("lab says no PCs match and that the attention list is not filtered", /No PCs match[\s\S]*not just the filtered/.test(await page.locator("[data-filter-note]").innerText()));
  ok("all 120 PCs dimmed when nothing matches", (await page.locator('.pc[data-dim="true"]').count()) === 120);
  await shot(page, "04-empty");
  if (SHOTS) await page.locator("section[aria-label='Lab floor map']").screenshot({ path: `${SHOTS}/04b-empty-lab-panel.png` });
  await page.click("text=Clear all filters");
  await page.waitForTimeout(700);
  ok("clearing restores undimmed PCs", (await page.locator('.pc[data-dim="true"]').count()) === 0);
  // error state
  await page.context().route("**/api/**", (r) => r.abort());
  await page.waitForTimeout(5200);
  ok("error banner while API is severed", await page.locator("text=Live data unavailable").isVisible());
  ok("lab states it is showing a stale snapshot with a time", /last snapshot from .*out of date/.test(await page.locator("[data-stale-note]").innerText()));
  ok("last known 120 PCs stay on screen during the error", (await page.locator(".pc[data-env-id]").count()) === 120);
  await shot(page, "05-error");
  if (SHOTS) await page.locator("section[aria-label='Lab floor map']").screenshot({ path: `${SHOTS}/05b-error-lab-panel.png` });
  await page.context().unroute("**/api/**");
  await page.click("text=Retry now");
  await page.waitForTimeout(1500);
  ok("retry clears the error", !(await page.locator("text=Live data unavailable").isVisible()));
  ok("stale note gone after recovery", (await page.locator("[data-stale-note]").count()) === 0);
  // dark
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot(page, "06-dark");
  // loading skeleton
  const slow = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await slow.context().route("**/api/environments**", async (r) => { await new Promise((x) => setTimeout(x, 4000)); r.continue(); });
  await slow.goto(BASE, { waitUntil: "domcontentloaded" });
  await slow.waitForTimeout(1200);
  ok("loading skeleton PCs show while waiting", (await slow.locator(".skeleton").count()) > 0);
  await shot(slow, "07-loading");
  // tablet and phone
  for (const [w, h, name] of [[1024, 800, "08-1024"], [768, 1000, "09-768"]]) {
    const t = await open({ width: w, height: h });
    ok(`no page-level horizontal overflow at ${w}px`, await t.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await shot(t, name);
    await t.close();
  }
  const m = await open({ width: 390, height: 844 });
  ok("no page-level horizontal overflow at 390px", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  ok("phone shows the list shortcut", await m.getByRole("button", { name: "Open list" }).isVisible());
  await m.getByRole("button", { name: "Open list" }).scrollIntoViewIfNeeded();
  await shot(m, "10-phone-floor");
  await m.getByRole("button", { name: "Open list" }).click();
  await m.waitForFunction(() => document.querySelectorAll("tbody tr[data-env-id]").length === 120);
  ok("Open list switches to the 120-row table", true);
  await shot(m, "11-phone-list");
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
