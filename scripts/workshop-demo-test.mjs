// Run against a local dashboard with disposable workshop storage.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome-stable",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const api = (session) => fetch(`${BASE}/api/environments?include=all`, {
  headers: session ? { "x-demo-session": session } : undefined,
}).then(async (response) => {
  assert.ok(response.ok, `Local snapshot returned ${response.status}`);
  return response.json();
});
const sessionKey = "cloudlabs-demo-session";
const sessionId = (page) => page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
const seats = (page) => page.locator(".map-pc");
const seat = (page, id) => seats(page).and(page.locator(`[data-env-id="${id}"]`));
const view = (page, mode) => page.getByRole("group", { name: "Map view mode" }).getByRole("button", { name: mode, exact: true });
const colors = (page) => page.getByRole("group", { name: "Color seats by" });
const details = (page) => page.getByRole("region", { name: /^Details for/ });
const guide = (page) => page.getByRole("region", { name: "Guided demo" });
const liveGuide = (page, pattern, timeout = 10000) =>
  guide(page).getByRole("status").filter({ hasText: pattern }).waitFor({ timeout });

const writes = [];
let providerRequests = 0;
async function open(width = 1440, noWebGL = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(BASE).origin) return route.abort();
    if (["/api/agent", "/api/nl-filter"].includes(url.pathname)) {
      providerRequests++;
      return route.abort();
    }
    if (request.method() === "POST") writes.push([url.pathname, request.headers()["x-demo-session"]]);
    return route.continue();
  });
  if (noWebGL) {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        return kind.startsWith("webgl") ? null : original.call(this, kind, ...args);
      };
    });
  }
  return page;
}

try {
  const sharedBefore = await api();
  const page = await open();
  await page.goto(BASE);
  await page.getByText("Shared workshop · Simulated data", { exact: true }).waitFor();
  await page.getByText("120 of 120 shown", { exact: true }).waitFor();
  assert.equal(writes.length, 0, "Loading shared must not start a demo or repair a PC");
  await page.getByRole("button", { name: "Start fresh demo" }).click();
  await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
  await view(page, "2D").click();
  await seats(page).nth(119).waitFor();
  const freshId = await sessionId(page);
  assert.ok(freshId);
  const snapshot = await api(freshId);
  assert.equal(snapshot.actions.length, 0);
  const identity = await seats(page).evaluateAll((elements) => elements.map((el) => [el.dataset.envId, el.dataset.seat]));
  assert.equal(identity.length, 120);
  assert.deepEqual(new Set(identity.map(([id]) => id)), new Set(snapshot.everyone.map(({ id }) => id)));
  for (const [id, label] of identity) {
    const index = ((Number(id.slice(4)) - 1) * 37) % 120;
    assert.equal(label, String.fromCharCode(65 + Math.floor(index / 12)) + (index % 12 + 1));
  }

  await seats(page).first().focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await details(page).waitFor();
  const [targetId, targetSeat] = identity[13];
  assert.match(await details(page).innerText(), new RegExp(`Seat ${targetSeat} · ${targetId}`));
  await page.getByRole("textbox", { name: "Search learner" }).fill(targetSeat);
  await page.getByText("1 of 120 highlighted", { exact: true }).waitFor();
  assert.equal(await seats(page).and(page.locator('[data-dim="true"]')).count(), 119);
  assert.match(await page.locator("[data-filter-note]").innerText(), /dimmed and remain selectable/);
  const screen = seat(page, targetId).locator("[data-map-screen]");
  const statusColor = await screen.getAttribute("fill");
  await colors(page).getByRole("button", { name: "Spend" }).click();
  const spendColor = await screen.getAttribute("fill");
  assert.notEqual(spendColor, statusColor);
  await colors(page).getByRole("button", { name: "Progress" }).click();
  assert.notEqual(await screen.getAttribute("fill"), statusColor);
  assert.notEqual(await screen.getAttribute("fill"), spendColor);
  await view(page, "3D").click();
  await page.locator(".room-stage canvas").waitFor();
  assert.match(await details(page).innerText(), new RegExp(targetId));
  assert.equal(await colors(page).getByRole("button", { name: "Progress" }).getAttribute("aria-pressed"), "true");
  await view(page, "2D").click();
  assert.equal(await seat(page, targetId).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("textbox", { name: "Search learner" }).inputValue(), targetSeat);
  assert.equal(await seats(page).and(page.locator('[data-dim="true"]')).count(), 119);
  assert.equal(await sessionId(page), freshId);
  await page.getByRole("button", { name: "Close details" }).click();
  const dimmedSeat = seats(page).and(page.locator('[data-dim="true"]')).first();
  const dimmedId = await dimmedSeat.getAttribute("data-env-id");
  await dimmedSeat.click();
  assert.match(await details(page).innerText(), new RegExp(dimmedId));
  await page.getByRole("button", { name: "Close details" }).click();
  const svg = page.locator(".top-down-map");
  const fit = await svg.getAttribute("viewBox");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoom = await svg.getAttribute("viewBox");
  assert.notEqual(zoom, fit);
  await svg.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const box = await svg.boundingBox();
  assert.ok(await svg.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), "The drag must start inside the visible map");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 25, { steps: 5 });
  await page.mouse.up();
  assert.notEqual(await svg.getAttribute("viewBox"), zoom);
  assert.equal(await details(page).count(), 0);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  assert.equal(await svg.getAttribute("viewBox"), fit);
  console.log("PASS 120 stable seats, keyboard, pointer, pan/zoom/fit, projection, filters and color modes");

  const beforeGuideWrites = writes.length;
  let failCreate = true;
  const guideRequests = [];
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    guideRequests.push(route.request().method());
    if (failCreate) {
      failCreate = false;
      return route.fulfill({ status: 429, json: { error: "rate_limited" } });
    }
    return route.fallback();
  });
  const startGuide = page.getByRole("button", { name: "Start guided demo" });
  await startGuide.click();
  await page.getByText(/Too many demo starts/).waitFor();
  assert.equal(await sessionId(page), freshId);
  assert.equal(await guide(page).count(), 0);
  assert.equal(guideRequests.length, 1);

  let failAction = true;
  let releaseRepair;
  const repairGate = new Promise((resolve) => { releaseRepair = resolve; });
  const actionRequests = [];
  await page.route("**/reprovision", async (route) => {
    actionRequests.push(route.request().headers()["x-demo-session"]);
    if (failAction) {
      failAction = false;
      return route.fulfill({ status: 503, json: { error: "persist_unavailable" } });
    }
    await repairGate;
    return route.fallback();
  });
  await startGuide.click();
  await liveGuide(page, /Use Reprovision environment/);
  const guidedId = await sessionId(page);
  assert.ok(guidedId && guidedId !== freshId);
  const repairedId = await seats(page).and(page.locator('[aria-pressed="true"]')).getAttribute("data-env-id");
  const failed = (await api(guidedId)).everyone.find(({ id }) => id === repairedId);
  assert.equal(failed.state, "failed");
  assert.ok((await guide(page).innerText()).includes(failed.failureReason));

  const repair = details(page).getByRole("button", { name: "Reprovision environment", exact: true });
  await repair.click();
  await liveGuide(page, /could not be confirmed/);
  assert.equal((await api(guidedId)).actions.length, 0);
  assert.equal(await repair.isEnabled(), true);
  await repair.click();
  await liveGuide(page, /Requesting simulated reprovision/);
  await view(page, "3D").click();
  assert.equal(await details(page).getByRole("button", { name: /Reprovisioning/ }).isDisabled(), true);
  await view(page, "2D").click();
  assert.equal(await seat(page, repairedId).getAttribute("aria-pressed"), "true");
  releaseRepair();
  await liveGuide(page, /is provisioning/);
  const afterRepair = await api(guidedId);
  assert.equal(afterRepair.actions.length, 1);
  assert.equal(afterRepair.actions[0].id, repairedId);
  assert.deepEqual(actionRequests, [guidedId, guidedId]);
  await liveGuide(page, /is Ready for the learner|is now In use/, 30000);
  await guide(page).getByRole("button", { name: "Close guide" }).click();
  assert.equal(await guide(page).count(), 0);
  await page.reload();
  await page.getByText("Isolated demo · Simulated data", { exact: true }).waitFor();
  assert.equal(await sessionId(page), guidedId);
  assert.equal(await guide(page).count(), 0);
  assert.deepEqual(writes.slice(beforeGuideWrites).map(([path]) => path), ["/api/session", `/api/environments/${repairedId}/reprovision`]);
  assert.equal((await api(freshId)).actions.length, 0);
  await page.getByRole("button", { name: "Return to shared" }).click();
  await page.getByText("Shared workshop · Simulated data", { exact: true }).waitFor();
  assert.equal(await sessionId(page), null);
  const sharedAfter = await api();
  assert.equal(sharedAfter.summary.sessionStartedAt, sharedBefore.summary.sessionStartedAt);
  assert.deepEqual(sharedAfter.actions, sharedBefore.actions);
  console.log("PASS isolated start, rate limiting, real guide repair progression, failed POST, dismissal, restoration and shared preservation");
  await page.close();

  const noFailures = await open(390, true);
  await noFailures.route("**/api/environments?**", async (route) => {
    if (!route.request().headers()["x-demo-session"]) return route.fallback();
    const response = await route.fetch();
    const snapshot = await response.json();
    const stripFailures = (rows) => rows.filter(({ state }) => state !== "failed");
    await route.fulfill({ response, json: { ...snapshot, everyone: stripFailures(snapshot.everyone), environments: stripFailures(snapshot.environments) } });
  });
  await noFailures.goto(BASE);
  await noFailures.getByRole("button", { name: "Start guided demo" }).click();
  await liveGuide(noFailures, /No failed PC is available/);
  assert.equal(await details(noFailures).count(), 0);
  await noFailures.getByRole("button", { name: "Return to shared" }).click();
  assert.equal(await guide(noFailures).count(), 0);
  await noFailures.close();
  console.log("PASS missing failure and guide reset on session switch");

  for (const width of [320, 390]) {
    const mobile = await open(width, true);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let failSnapshot = true;
    await mobile.route("**/api/environments?**", async (route) => {
      await gate;
      if (failSnapshot) return route.fulfill({ status: 503, json: {} });
      return route.fallback();
    });
    await mobile.goto(BASE, { waitUntil: "domcontentloaded" });
    await mobile.getByText("Loading learners…", { exact: true }).waitFor();
    assert.equal(await mobile.locator(".stat-value-skeleton").count(), 4);
    assert.equal(await mobile.locator(".workshop-title-skeleton").count(), 1);
    assert.equal(await mobile.locator(".room-title-skeleton").count(), 1);
    assert.equal(await mobile.locator(".room-skeleton .skeleton").count(), 48);
    assert.equal(await mobile.getByText(/0 of 120/).count(), 0);
    assert.equal(await mobile.locator(".room-stage canvas").count(), 0);
    release();
    await mobile.getByText("Learner count unavailable").waitFor();
    assert.equal(await mobile.locator(".stat-value-skeleton").count(), 0);
    failSnapshot = false;
    await mobile.getByRole("button", { name: "Retry now" }).click();
    await mobile.getByText("120 of 120 shown", { exact: true }).waitFor();
    await mobile.getByRole("button", { name: "Open 2D map" }).click();
    await seats(mobile).nth(119).waitFor();
    failSnapshot = true;
    await mobile.locator(".room-notice").filter({ hasText: /Reconnecting/ }).waitFor();
    assert.equal(await seats(mobile).count(), 120);
    assert.equal(await mobile.locator(".stat-value-skeleton").count(), 0);
    for (const mode of ["Status", "Spend", "Progress"]) {
      await colors(mobile).getByRole("button", { name: mode, exact: true }).click();
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), width);
    }
    await seats(mobile).first().click();
    await details(mobile).waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), width);
    await mobile.close();
    console.log(`PASS ${width}px overflow, first-load placeholders, failure/retry, no-WebGL access and stale snapshot`);
  }
  assert.equal(providerRequests, 0);
} finally {
  await browser.close();
}
