// Run after npm run build. Two processes invoke the compiled Next handlers
// over IPC, with a disposable shared storage directory and no listening port.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NextRequest } from "next/server.js";

if (process.argv[2] === "--handler") {
  const require = createRequire(import.meta.url);
  const route = (name) => require(`../.next/server/app/api/${name}/route.js`).routeModule.userland;
  const environments = route("environments");
  const session = route("session");
  const action = route("environments/[id]/reprovision");
  process.on("message", async ({ seq, method, pathname, demo }) => {
    try {
      const req = new NextRequest(`http://localhost${pathname}`, { method, headers: demo === undefined ? {} : { "x-demo-session": demo } });
      const result = pathname.startsWith("/api/session") ? await session[method](req)
        : method === "GET" ? await environments.GET(req)
        : await action.POST(req, { params: Promise.resolve({ id: pathname.split("/")[3] }) });
      process.send({ seq, code: result.status, body: await result.json() });
    } catch (err) {
      process.send({ seq, error: err.message });
    }
  });
} else {
  fs.mkdirSync(".data", { recursive: true });
  const data = fs.mkdtempSync(path.resolve(".data", "two-instance-"));
  const children = [];
  const ttl = 80;
  let passed = 0;
  const ok = (name, result) => {
    assert.ok(result, name);
    passed++;
    console.log(`PASS ${name}`);
  };
  const start = () => {
    const child = fork(process.argv[1], ["--handler"], {
      env: { WORKSHOP_DATA_DIR: data, PERSIST_REFRESH_MS: String(ttl) },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    children.push(child);
    let seq = 0;
    const pending = new Map();
    child.on("message", ({ seq, error, code, body }) => {
      const waiter = pending.get(seq);
      pending.delete(seq);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve({ code, body });
    });
    child.on("exit", (code) => {
      for (const waiter of pending.values()) waiter.reject(new Error(`Handler exited: ${code}`));
    });
    const call = (method, pathname, demo) => new Promise((resolve, reject) => {
      pending.set(++seq, { resolve, reject });
      child.send({ seq, method, pathname, demo });
    });
    return { child, call };
  };
  const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  const snapshot = (instance, demo, query = "include=all") => instance.call("GET", `/api/environments?${query}`, demo);
  const action = (instance, id, demo) => instance.call("POST", `/api/environments/${id}/reprovision`, demo);
  const create = (instance) => instance.call("POST", "/api/session");
  const byId = (response, id) => response.body.everyone.find((r) => r.id === id);
  const failedIds = (response) => response.body.everyone.filter((row) => row.state === "failed").map((row) => row.id);
  const matchesCohort = ({ code, body }) => {
    if (code !== 200 || body.total !== 120 || body.everyone.length !== 120 || body.summary.now !== body.now) return false;
    const { everyone, environments, summary } = body;
    for (const [state, count] of Object.entries(summary.byState)) {
      if (everyone.filter((row) => row.state === state).length !== count) return false;
    }
    const cents = (dollars) => Math.round(dollars * 100);
    const spend = everyone.reduce((s, row) => s + row.runtimeMinutes * row.ratePerHour / 60, 0);
    const progress = everyone.reduce((s, row) => s + row.progressPct, 0);
    return summary.total === 120 && summary.active === 120 - summary.byState.deprovisioned &&
      summary.failures === summary.byState.failed && summary.stuckCount === everyone.filter((row) => row.stuck).length &&
      cents(summary.estimatedSpend) === cents(spend) && summary.avgCompletionPct === Math.round(progress / 120) &&
      (body.filter.states ? environments.length === summary.byState.failed && environments.every((row) => row.state === "failed") : environments.length === 120);
  };

  try {
    let a = start();
    const b = start();
    const [firstA, firstB] = await Promise.all([snapshot(a), snapshot(b)]);
    ok("simultaneous cold loads adopt one shared anchor", firstA.body.summary.sessionStartedAt === firstB.body.summary.sessionStartedAt);
    ok("both instances serve the same 120-row seeded shared cohort", JSON.stringify(failedIds(firstA)) === JSON.stringify(failedIds(firstB)) && matchesCohort(firstA) && matchesCohort(firstB));
    const [x, y, z, w] = failedIds(firstA);
    assert.ok(w, "need at least four seeded failures");

    ok("shared reprovision on A accepted", (await action(a, x)).body.environment?.state === "provisioning");
    await delay(ttl * 2);
    ok("warm B sees A's action after refresh", byId(await snapshot(b), x).state !== "failed");
    const concurrent = await Promise.all([
      action(a, y), action(b, z),
      ...Array.from({ length: 20 }, (_, i) => snapshot(i % 2 ? a : b, undefined, "include=all&states=failed")),
    ]);
    ok("concurrent actions are both accepted", concurrent.slice(0, 2).every(({ code, body }) => code === 200 && body.ok));
    ok("20 concurrent filtered responses reconcile their rows, state counts, progress and spend", concurrent.slice(2).every(matchesCohort));
    await delay(ttl * 2);
    const [afterA, afterB] = await Promise.all([snapshot(a), snapshot(b)]);
    ok("both independent instances retain both actions", [afterA, afterB].every((s) => byId(s, y).state !== "failed" && byId(s, z).state !== "failed"));

    const actionsDir = path.join(data, "actions");
    const savedDir = path.join(data, "saved-actions");
    fs.renameSync(actionsDir, savedDir);
    fs.writeFileSync(actionsDir, "trigger a write error in the disposable store");
    const writeFailure = await action(a, w);
    fs.unlinkSync(actionsDir);
    fs.renameSync(savedDir, actionsDir);
    ok("failed persistence returns 503", writeFailure.code === 503 && writeFailure.body.error === "persist_failed");
    ok("failed write leaves the prior state intact", byId(await snapshot(a), w).state === "failed");

    const [createdA, createdB] = await Promise.all([create(a), create(b)]);
    const demoA = createdA.body.id;
    const demoB = createdB.body.id;
    ok("demo creation is explicit and returns distinct expiring ids", createdA.code === 201 && createdB.code === 201 && !!demoA && !!demoB && demoA !== demoB && createdA.body.expiresAt > Date.now());
    const [seedA, seedB] = await Promise.all([snapshot(a, demoA), snapshot(b, demoB)]);
    ok("fresh demos each contain a full untouched cohort", matchesCohort(seedA) && matchesCohort(seedB) && byId(seedA, x).state === "failed" && byId(seedB, x).state === "failed");
    ok("mode and expiry are present only for scoped demo rows", seedA.body.sessionMode === "demo" && seedA.body.sessionExpiresAt === createdA.body.expiresAt && firstA.body.sessionMode === "shared" && firstA.body.sessionExpiresAt === null);
    ok("demo reprovision persists in its own scope", (await action(a, w, demoA)).body.environment?.state === "provisioning" && byId(await snapshot(b, demoA), w).state !== "failed");
    const [otherDemo, shared] = await Promise.all([snapshot(b, demoB), snapshot(b)]);
    ok("an action leaks neither state nor transitions into another demo or shared", byId(otherDemo, w).state === "failed" && byId(shared, w).state === "failed" && otherDemo.body.transitions.every((t) => t.id !== w) && shared.body.transitions.every((t) => t.id !== w));

    await stop(a.child);
    a = start();
    const restarted = await snapshot(a, demoA);
    const summary = await a.call("GET", "/api/session", demoA);
    ok("a cold instance reconstructs the isolated action and scoped summary", byId(restarted, w).state !== "failed" && summary.body.sessionStartedAt === restarted.body.summary.sessionStartedAt);
    const unknown = "00000000-0000-4000-8000-000000000000";
    const invalidRead = await snapshot(a, unknown);
    const invalidWrite = await action(a, w, "../../actions");
    ok("unknown and malformed demo ids cannot fall back to shared", invalidRead.code === 404 && invalidRead.body.error === "demo_not_found" && invalidWrite.code === 404 && byId(await snapshot(a), w).state === "failed");
    fs.writeFileSync(path.join(data, "demos", demoA, "anchor.json"), JSON.stringify({ sessionStartedAt: Date.now() - 25 * 3600_000 }));
    const [expiredRead, expiredWrite] = await Promise.all([snapshot(a, demoA), action(b, w, demoA)]);
    ok("expired demo rejects reads and actions", expiredRead.code === 410 && expiredWrite.code === 410 && expiredRead.body.error === "demo_expired");
    ok("creating a new demo leaves existing scopes and expired records intact", (await create(a)).code === 201 && byId(await snapshot(a, demoB), w).state === "failed" && (await snapshot(a, demoA)).code === 410);
    console.log(`${passed} checks passed.`);
  } finally {
    await Promise.all(children.map(stop));
    fs.rmSync(data, { recursive: true, force: true });
  }
}
