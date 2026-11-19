// Capture the current dashboard against a running app.
// Set MOCK_MODEL=1 only when the app uses the loopback test provider.
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:3000";
const browser = await chromium.launch();
const viewport = { width: 1440, height: 900 };
const floorSeats = ".pc[data-env-id]";
const tableRows = "tbody tr[data-env-id]";
const capture = (page, name) => page.screenshot({ path: `screenshots/final-${name}.png`, animations: "disabled" });
const fullCohort = (page, selector) => page.waitForFunction((selector) => document.querySelectorAll(selector).length === 120, selector);
const open = (page, path) => page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
const environmentApi = (url) => url.pathname === "/api/environments";

try {
  const floor = await browser.newPage({ viewport, colorScheme: "light" });
  await open(floor, "/");
  await floor.getByRole("button", { name: "Start fresh demo" }).click();
  await floor.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
  await fullCohort(floor, floorSeats);
  await capture(floor, "floor-light");
  await floor.locator('.pc[data-st="failed"]').first().click();
  await floor.getByRole("region", { name: /^Details for/ }).waitFor();
  await capture(floor, "detail");
  await floor.keyboard.press("Escape");
  await floor.getByRole("button", { name: "Switch to dark theme" }).click();
  await capture(floor, "floor-dark");
  await floor.getByRole("button", { name: "Spend", exact: true }).click();
  await capture(floor, "spend-dark");

  const table = await browser.newPage({ viewport, colorScheme: "light" });
  let finishLoading;
  const hold = new Promise((resolve) => { finishLoading = resolve; });
  await table.route(environmentApi, async (route) => { await hold; await route.continue(); });
  try {
    await open(table, "/?view=table");
    await table.locator(".ops-table .skeleton").first().waitFor();
    await capture(table, "loading");
  } finally {
    const loaded = table.waitForResponse((response) => new URL(response.url()).pathname === "/api/environments");
    finishLoading();
    await loaded;
    await table.unroute(environmentApi, undefined, { behavior: "wait" });
  }
  await fullCohort(table, tableRows);
  await capture(table, "table");

  await table.route(environmentApi, (route) => route.abort());
  await table.getByRole("alert").filter({ hasText: "Live data unavailable" }).waitFor();
  await capture(table, "error");
  await table.unroute(environmentApi);
  await table.getByRole("button", { name: "Retry now" }).click();
  await table.getByRole("alert").filter({ hasText: "Live data unavailable" }).waitFor({ state: "hidden" });

  const search = table.getByRole("textbox", { name: "Search learner" });
  await search.fill("zz-no-such-learner");
  await table.getByText("No environments match these filters.", { exact: false }).first().waitFor();
  await capture(table, "empty");
  await table.getByRole("button", { name: "Clear all filters" }).click();
  await fullCohort(table, tableRows);

  const nl = table.getByRole("textbox", { name: "Natural language filter" });
  if (process.env.MOCK_MODEL === "1") {
    await nl.fill("learners who barely made any progress");
    await nl.press("Enter");
    const confirm = table.getByRole("button", { name: "Apply suggested filter" });
    await confirm.waitFor();
    await fullCohort(table, tableRows);
    await capture(table, "mock-model-confirmation");
    await confirm.click();
    await table.getByText("compiled by the AI model, confirmed by you", { exact: false }).waitFor();
    await table.getByRole("button", { name: "Clear filter" }).click();
  }
  await nl.fill("learners who have barely progressed");
  await nl.press("Enter");
  await table.locator(".note-warn[role=alert]").waitFor();
  await table.getByRole("button", { name: "More filters" }).click();
  await capture(table, "model-fallback");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
  await open(mobile, "/");
  await fullCohort(mobile, floorSeats);
  await capture(mobile, "mobile");
  console.log(`Captured ${process.env.MOCK_MODEL === "1" ? 11 : 10} screenshots, with all 120 seats and rows loaded for dense views.`);
} finally {
  await browser.close();
}
