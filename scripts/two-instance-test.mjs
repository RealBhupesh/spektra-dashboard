// Cross-instance persistence regressions, run against TWO independently warm
// server processes sharing one file backend (.data/):
//   1. An action taken on instance A becomes visible on warm instance B
//      within the refresh window (no forever-stale memory).
//   2. Concurrent actions on A and B are BOTH kept (append-only log, no
//      read-modify-write lost update).
//   3. A mutation that cannot be written fails visibly (503 persist_failed)
//      and leaves state unchanged, instead of pretending to save.
// Usage: npm run build && node scripts/two-instance-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT_A = 3101;
const PORT_B = 3102;
const REFRESH_MS = 1500;
const base = (p) => `http://localhost:${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
};

fs.rmSync(".data", { recursive: true, force: true });

const kids = [];
function start(port) {
  const k = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...process.env, PERSIST_REFRESH_MS: String(REFRESH_MS) },
    stdio: "ignore",
  });
  kids.push(k);
  return k;
}

async function waitUp(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base(port)}/api/session`, { cache: "no-store" });
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`server on ${port} did not come up`);
}

async function envs(port) {
  const r = await fetch(`${base(port)}/api/environments?limit=200`, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${port} -> ${r.status}`);
  return (await r.json()).environments;
}
const failedIds = (list) => list.filter((e) => e.state === "failed").map((e) => e.id);
const stateOf = (list, id) => list.find((e) => e.id === id)?.state;

async function reprovision(port, id) {
  const r = await fetch(`${base(port)}/api/environments/${id}/reprovision`, { method: "POST" });
  return r;
}

try {
  start(PORT_A);
  start(PORT_B);
  await waitUp(PORT_A);
  await waitUp(PORT_B);

  // Warm both: each loads anchor + actions into its own process memory.
  const a0 = await envs(PORT_A);
  const b0 = await envs(PORT_B);
  const f0 = failedIds(a0);
  ok("both instances serve the same failed cohort", JSON.stringify(f0) === JSON.stringify(failedIds(b0)));
  if (f0.length < 3) throw new Error(`need at least 3 failed envs to test, got ${f0.length}`);

  // 1. Freshness: act on A; B must see it within the refresh window even
  //    though B's process memory was warm before the action.
  const [x, y, z] = f0;
  const r1 = await reprovision(PORT_A, x);
  ok("reprovision on A accepted", r1.ok, `status ${r1.status}`);
  await sleep(REFRESH_MS + 1200);
  const b1 = await envs(PORT_B);
  ok("warm instance B sees A's action after refresh window", ["provisioning", "ready", "in_use"].includes(stateOf(b1, x)), `B sees ${stateOf(b1, x)}`);

  // 2. No lost update: A and B act on different envs at the same instant.
  const [ry, rz] = await Promise.all([reprovision(PORT_A, y), reprovision(PORT_B, z)]);
  ok("concurrent reprovisions both accepted", ry.ok && rz.ok, `A:${ry.status} B:${rz.status}`);
  await sleep(REFRESH_MS + 1200);
  const a2 = await envs(PORT_A);
  const b2 = await envs(PORT_B);
  const alive = (s) => ["provisioning", "ready", "in_use"].includes(s);
  ok("A kept both concurrent actions", alive(stateOf(a2, y)) && alive(stateOf(a2, z)), `A: ${stateOf(a2, y)} ${stateOf(a2, z)}`);
  ok("B kept both concurrent actions", alive(stateOf(b2, y)) && alive(stateOf(b2, z)), `B: ${stateOf(b2, y)} ${stateOf(b2, z)}`);

  // 3. Unwritable store: the mutation must fail visibly and change nothing.
  fs.chmodSync(".data/actions", 0o555);
  const w = failedIds(await envs(PORT_A)).find((id) => ![x, y, z].includes(id));
  const r3 = await reprovision(PORT_A, w);
  const body3 = await r3.json().catch(() => ({}));
  ok("failed write returns 503 persist_failed", r3.status === 503 && body3.error === "persist_failed", `status ${r3.status} ${JSON.stringify(body3)}`);
  fs.chmodSync(".data/actions", 0o755);
  await sleep(REFRESH_MS + 1200);
  ok("unsaved action left state unchanged", stateOf(await envs(PORT_A), w) === "failed", `A sees ${stateOf(await envs(PORT_A), w)}`);
} catch (err) {
  failed++;
  console.log(`FAIL harness: ${err.message}`);
} finally {
  for (const k of kids) k.kill("SIGTERM");
  try { fs.chmodSync(".data/actions", 0o755); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
