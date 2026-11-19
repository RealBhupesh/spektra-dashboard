// Route-level tests for the simulation assistant (app/api/agent/route.ts).
// Run against the compiled Next routes after `npm run build`, like
// nl-route-test.mjs. Storage is a temp file backend; the LLM provider is
// stubbed through fetch in the provider phase. No listener or credential.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { NextRequest } from "next/server.js";

for (const name of ["GROQ_API_KEY", "GROQ_MODEL", "GROQ_AGENT_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) delete process.env[name];
process.env.WORKSHOP_DATA_DIR = mkdtempSync(join(tmpdir(), "spektra-agent-test-"));
// Make writes from one route bundle visible to the others within a test run.
process.env.PERSIST_REFRESH_MS = "50";

const require = createRequire(import.meta.url);
const { POST: agentPOST } = require("../.next/server/app/api/agent/route.js").routeModule.userland;
const { GET: envsGET } = require("../.next/server/app/api/environments/route.js").routeModule.userland;
const { POST: sessionPOST } = require("../.next/server/app/api/session/route.js").routeModule.userland;

let ipSeq = 0;
const freshIp = () => `10.1.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;

const ask = async (body, { demoId, ip } = {}) => {
  const res = await agentPOST(new NextRequest("http://localhost/api/agent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip ?? freshIp(),
      ...(demoId ? { "x-demo-session": demoId } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
};

const getEnvs = async (query = "", demoId) => {
  const res = await envsGET(new NextRequest(`http://localhost/api/environments${query ? `?${query}` : ""}`, {
    headers: { "x-forwarded-for": "10.9.9.9", ...(demoId ? { "x-demo-session": demoId } : {}) },
  }));
  return { status: res.status, body: await res.json() };
};

const newDemoSession = async () => {
  const res = await sessionPOST(new NextRequest("http://localhost/api/session", {
    method: "POST", headers: { "x-forwarded-for": "10.9.9.8" },
  }));
  return (await res.json()).id;
};

const CONTRACT_KEYS = ["ok", "reply", "source", "degraded", "now", "stateVersion", "stateVersionAfter",
  "summary", "selected", "suggestedFilter", "proposedActions", "executedActions", "actionsAppended", "refreshRequired"];

// ---------- Phase A: input validation (no provider configured) ----------

test("rejects malformed bodies and bad fields", async () => {
  assert.equal((await ask([])).status, 400);
  assert.equal((await ask("not json")).status, 400);
  assert.deepEqual((await ask({})).body, { error: "empty_message" });
  assert.deepEqual((await ask({ message: "   " })).body, { error: "empty_message" });
  assert.equal((await ask({ message: "x".repeat(501) })).body.error, "message_too_long");
  assert.equal((await ask({ message: "hi", selectedId: "pc-1" })).body.error, "bad_request");
  assert.equal((await ask({ confirm: { kind: "restart", ids: ["env-001"] } })).body.error, "unknown_action_kind");
  assert.equal((await ask({ confirm: { kind: "reprovision", ids: [] } })).body.error, "bad_request");
  assert.equal((await ask({ confirm: { kind: "reprovision", ids: Array.from({ length: 26 }, (_, i) => `env-${String(i + 1).padStart(3, "0")}`) } })).body.error, "too_many_actions");
  assert.equal((await ask({ confirm: { kind: "reprovision", ids: ["env-001", "ENV-001"] } })).body.error, "bad_request");
  assert.equal((await ask({ confirm: { kind: "reprovision", ids: ["nope"] } })).body.error, "bad_request");
});

test("unknown selected workstation is a 404", async () => {
  const { status, body } = await ask({ message: "what is this pc doing?", selectedId: "env-999" });
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "unknown_selected" });
});

// ---------- Phase B: local Q&A (provider absent => visible local fallback) ----------

test("off/not-off counts use the domain meaning: off = deprovisioned, failed distinct", async () => {
  const { status, body } = await ask({ message: "how many pcs are off and how many are not off?" });
  assert.equal(status, 200);
  for (const key of CONTRACT_KEYS) assert.ok(key in body, `missing ${key}`);
  assert.equal(body.source, "local");
  assert.equal(body.degraded, false); // confident deterministic answer, labeled local
  // off = deprovisioned (finished, no longer billing); on = active.
  assert.match(body.reply, new RegExp(`${body.summary.byState.deprovisioned} of ${body.summary.total} PCs are off`));
  assert.match(body.reply, new RegExp(`${body.summary.active} are not off`));
  // failed stays visible and distinct from off.
  assert.match(body.reply, new RegExp(`${body.summary.byState.failed} (is|are) failed`));
  assert.doesNotMatch(body.reply, /failed \(off\)/i);
  assert.equal(body.refreshRequired, false);
  assert.deepEqual(body.executedActions, []);
  assert.deepEqual(body.actionsAppended, []);
});

test("show-failed requests also return a validated suggested filter", async () => {
  const { body } = await ask({ message: "show me the failed pcs" });
  assert.equal(body.source, "local");
  assert.match(body.reply, /Failed:/);
  assert.deepEqual(body.suggestedFilter.filter.states, ["failed"]);
  assert.ok(Array.isArray(body.suggestedFilter.description));
});

test("show-off requests map to deprovisioned, not failed", async () => {
  const { body } = await ask({ message: "show me which pcs are off" });
  assert.equal(body.source, "local");
  assert.match(body.reply, /off \(finished/);
  assert.deepEqual(body.suggestedFilter.filter.states, ["deprovisioned"]);
});

test("stuck, spend, progress, active and status answers carry real numbers", async () => {
  const stuck = (await ask({ message: "is anyone stuck?" })).body;
  assert.match(stuck.reply, /stuck/i);
  const spend = (await ask({ message: "what is the total spend?" })).body;
  assert.match(spend.reply, new RegExp(spend.summary.estimatedSpend.toFixed(2).replace(".", "\\.")));
  const progress = (await ask({ message: "average completion?" })).body;
  assert.match(progress.reply, new RegExp(`${progress.summary.avgCompletionPct}%`));
  const active = (await ask({ message: "how many environments are active?" })).body;
  assert.match(active.reply, new RegExp(`${active.summary.active} of ${active.summary.total}`));
  const status = (await ask({ message: "status report please" })).body;
  assert.match(status.reply, /in use/);
});

test("selected workstation detail names the PC and its real state", async () => {
  const failed = (await getEnvs("states=failed")).body.environments;
  assert.ok(failed.length > 0, "seed should guarantee failed environments at anchor");
  const e = failed[0];
  const { body } = await ask({ message: "what's going on with this pc?", selectedId: e.id });
  assert.equal(body.selected.id, e.id);
  assert.equal(typeof body.selected.spendUsd, "number");
  assert.match(body.reply, new RegExp(e.id));
  assert.match(body.reply, /failed/i);
  assert.match(body.reply, /fix this PC/i);
});

// ---------- Phase E: mocked provider (runs before any mutation) ----------

const originalFetch = globalThis.fetch;
let providerRespond = () => new Response(null, { status: 503 });
let providerCalls = 0;
globalThis.fetch = async (input, init) => {
  providerCalls++;
  return providerRespond(input, init);
};
after(() => { globalThis.fetch = originalFetch; });

const modelAnswer = (answer) => () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });

test("model classifies intent; facts are rendered server-side with the real numbers", async () => {
  process.env.LLM_BASE_URL = "http://127.0.0.1:3109/v1";
  process.env.LLM_API_KEY = "mock";
  process.env.LLM_MODEL = "mock";
  providerRespond = modelAnswer({ intent: "attention", suggestFilter: false, proposeRestartIds: [] });
  const { body } = await ask({ message: "what should I focus on first?" });
  assert.equal(body.source, "llm");
  assert.equal(body.degraded, false);
  // Rendered from the same snapshot as summary - the model never wrote these.
  assert.match(body.reply, new RegExp(`${body.summary.byState.failed} failed`));
  assert.match(body.reply, new RegExp(`${body.summary.stuckCount} learner`));
});

test("no model prose reaches the reply, however plausible", async () => {
  const envs = (await getEnvs()).body.environments;
  const firstName = envs[0].learnerName.split(" ")[0];
  // Ambiguous phrasing that the local parser cannot classify, so the model
  // classifier is invoked. Whatever free text it returns - benign lead-ins,
  // false healthy claims, smuggled digits/names/ids, markdown - is ignored,
  // not sanitized: only the server-rendered facts may reach the reply.
  for (const prose of [
    "Quick look at the room.",
    "All labs look healthy and everyone is on track.",
    `All ${envs.length} labs look fine`,
    `${firstName} says hi`,
    "check env-001 now",
    "```json x```",
  ]) {
    providerRespond = modelAnswer({ intent: "status", remark: prose, note: prose, suggestFilter: false, proposeRestartIds: [] });
    const { body } = await ask({ message: "so what's the vibe in here then?" });
    assert.equal(body.source, "llm");
    assert.equal(body.degraded, false);
    assert.doesNotMatch(body.reply, new RegExp(prose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.match(body.reply, /Cohort status:/);
  }
});

test("model proposals are limited to currently failed, known ids", async () => {
  const envs = (await getEnvs()).body.environments;
  const failed = envs.filter((e) => e.state === "failed");
  const notFailed = envs.find((e) => e.state !== "failed");
  assert.ok(failed.length && notFailed);
  providerRespond = modelAnswer({
    intent: "attention",
    suggestFilter: false,
    proposeRestartIds: [failed[0].id, notFailed.id, "env-999", "garbage"],
  });
  const { body } = await ask({ message: "what should we do about the lab?" });
  assert.equal(body.source, "llm");
  assert.deepEqual(body.proposedActions, [{ kind: "reprovision", ids: [failed[0].id], label: "Restart 1 failed environment" }]);
  assert.deepEqual(body.executedActions, []);
  assert.equal(body.refreshRequired, false);
});

test("uncompilable model filter request yields no suggestion", async () => {
  providerRespond = modelAnswer({ intent: "unknown",  suggestFilter: true, proposeRestartIds: [] });
  const { body } = await ask({ message: "can you highlight the stragglers?" });
  assert.equal(body.source, "llm");
  assert.equal(body.suggestedFilter, null);
});

test("invalid intent, malformed output and provider errors fall back to the visible local responder", async () => {
  for (const respond of [
    modelAnswer({ intent: "everything",  suggestFilter: false, proposeRestartIds: [] }),
    () => Response.json({ choices: [{ message: { content: "{not json" } }] }),
    () => Response.json({ choices: [{ message: { content: { intent: 3 } } }] }),
    () => new Response(null, { status: 503 }),
  ]) {
    providerRespond = respond;
    const before = providerCalls;
    const { body } = await ask({ message: "what should I focus on first?" });
    assert.equal(providerCalls, before + 1);
    assert.equal(body.source, "local");
    assert.equal(body.degraded, true);
    assert.match(body.reply, /where things stand/);
    assert.match(body.reply, new RegExp(`${body.summary.byState.failed} failed`));
  }
});

test("mixed off/failed questions answer with both counts and the working remainder", async () => {
  const { body } = await ask({ message: "how many pcs are off and how many failed?" });
  assert.equal(body.source, "local");
  assert.match(body.reply, new RegExp(`${body.summary.byState.deprovisioned} of ${body.summary.total} PCs are off`));
  assert.match(body.reply, new RegExp(`${body.summary.byState.failed} (is|are) failed`));
  const healthy = body.summary.active - body.summary.byState.failed;
  assert.match(body.reply, new RegExp(`The other ${healthy} are on and working`));
});

test("directive messages never reach the model", async () => {
  providerRespond = modelAnswer({ intent: "status",  suggestFilter: false, proposeRestartIds: [] });
  const before = providerCalls;
  await ask({ message: "please don't restart anything" });
  await ask({ message: "fix it" });
  assert.equal(providerCalls, before);
});

// ---------- Phase C: directive authority (provider restored to failing) ----------

test("negated directive is acknowledged and changes nothing", async () => {
  providerRespond = () => new Response(null, { status: 503 });
  const before = (await getEnvs()).body.stateVersion;
  const { body } = await ask({ message: "please don't restart the failed ones" });
  assert.match(body.reply, /won't restart/i);
  assert.deepEqual(body.executedActions, []);
  assert.equal(body.refreshRequired, false);
  assert.equal((await getEnvs()).body.stateVersion, before);
});

test("ambiguous directive asks instead of guessing", async () => {
  const { body } = await ask({ message: "fix it" });
  assert.match(body.reply, /Which PC/i);
  assert.deepEqual(body.executedActions, []);
});

test("directives aimed at off PCs never execute: off is finished, not a repair target", async () => {
  for (const message of ["turn on the off pcs", "restart the off ones"]) {
    const before = (await getEnvs()).body.stateVersion;
    const { body } = await ask({ message });
    assert.match(body.reply, /Nothing to restart/i, message);
    assert.match(body.reply, /deprovisioned/, message);
    assert.deepEqual(body.actionsAppended, [], message);
    assert.equal(body.refreshRequired, false, message);
    assert.equal((await getEnvs()).body.stateVersion, before, message);
  }
});

test("restart of a non-failed id is refused truthfully", async () => {
  const envs = (await getEnvs()).body.environments;
  const notFailed = envs.find((e) => e.state === "ready" || e.state === "in_use");
  const { body } = await ask({ message: `restart ${notFailed.id}` });
  assert.match(body.reply, /Nothing to restart/i);
  assert.match(body.reply, new RegExp(notFailed.id));
  assert.deepEqual(body.actionsAppended, []);
});

test("fix this PC restarts only the selected failed workstation, versions pinned to the real log", async () => {
  const failed = (await getEnvs("states=failed")).body.environments;
  const e = failed[0];
  const versionBefore = (await getEnvs()).body.stateVersion;
  const { body } = await ask({ message: "fix this pc", selectedId: e.id });
  const versionAfter = (await getEnvs()).body.stateVersion;
  assert.equal(body.executedActions.length, 1);
  const action = body.executedActions[0];
  assert.equal(action.id, e.id);
  assert.equal(action.learnerName, e.learnerName);
  assert.equal(action.ok, true);
  assert.equal(action.resultingState, "provisioning");
  assert.equal(body.actionsAppended.length, 1);
  // Pinned against the actual action log, not self-consistent arithmetic.
  assert.equal(body.stateVersion, versionBefore);
  assert.equal(body.stateVersionAfter, versionAfter);
  assert.equal(versionAfter, versionBefore + 1);
  assert.equal(body.refreshRequired, true);
  assert.match(body.reply, /provisioning/);
  assert.match(body.reply, /not yet recovered/);
  assert.doesNotMatch(body.reply, /\bfixed\b/i);
});

test("restart the failed ones executes all, reports progression, versions match the real log", async () => {
  const failedBefore = (await getEnvs("states=failed")).body.environments.length;
  assert.ok(failedBefore > 0);
  const versionBefore = (await getEnvs()).body.stateVersion;
  const { body } = await ask({ message: "restart the failed ones" });
  const versionAfter = (await getEnvs()).body.stateVersion;
  assert.equal(body.executedActions.length, failedBefore);
  assert.ok(body.executedActions.every((a) => a.ok && a.resultingState === "provisioning"));
  assert.equal(body.actionsAppended.length, failedBefore);
  assert.equal(body.stateVersion, versionBefore);
  assert.equal(body.stateVersionAfter, versionAfter);
  assert.equal(versionAfter, versionBefore + failedBefore);
  const after = (await getEnvs("states=failed")).body.environments.length;
  assert.ok(after < failedBefore, `failed should drop: ${failedBefore} -> ${after}`);
});

test("mixed-scope directive restarts the failed and discloses the excluded off PCs", async () => {
  const demoId = await newDemoSession();
  const { body } = await ask({ message: "fix the failed and off pcs" }, { demoId });
  assert.ok(body.executedActions.length > 0);
  assert.ok(body.executedActions.every((a) => a.ok && a.resultingState === "provisioning"));
  assert.match(body.reply, /off \(finished\) PCs? can't be restarted - excluded/);
  assert.match(body.reply, new RegExp(`${body.summary.byState.deprovisioned} off`));
});

// Race-test helpers. Workers are separate module registries over one shared
// file backend - two simulated server instances. The actions directory is
// the ground truth for what was appended; it bypasses every instance cache.
const waitWorker = (w, phase) => new Promise((resolve, reject) => {
  const onMsg = (m) => { if (m.phase === phase) { w.off("message", onMsg); resolve(m); } };
  w.on("message", onMsg);
  w.once("error", reject);
});
const spawnRacer = (workerData) => {
  const w = new Worker(new URL("./agent-race-worker.mjs", import.meta.url), { workerData });
  return { worker: w, done: waitWorker(w, "done") };
};
const demoActionFiles = (demoId) => readdirSync(join(process.env.WORKSHOP_DATA_DIR, "demos", demoId, "actions"));

test("concurrent confirms of the same restart append exactly once", async () => {
  const demoId = await newDemoSession();
  const before = (await getEnvs("", demoId)).body;
  const target = before.environments.find((e) => e.state === "failed");
  assert.ok(target, "demo cohort has a failed environment");
  const dir = process.env.WORKSHOP_DATA_DIR;
  const a = spawnRacer({ dir, demoId, targetId: target.id, lane: 1, preload: false });
  const b = spawnRacer({ dir, demoId, targetId: target.id, lane: 2, preload: false });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  for (const r of [ra, rb]) assert.equal(r.status, 200, JSON.stringify(r).slice(0, 300));
  const results = [ra.body, rb.body].map((body) => body.executedActions[0]);
  const oks = results.filter((x) => x.ok);
  const skips = results.filter((x) => !x.ok && x.skippedReason);
  // Exactly one append wins; the loser reports a truthful skip, never a
  // second restart.
  assert.equal(oks.length, 1, JSON.stringify(results));
  assert.equal(skips.length, 1, JSON.stringify(results));
  const files = demoActionFiles(demoId);
  assert.deepEqual(files, [`${target.id}-r0.json`], "exactly one epoch-keyed event on disk");
  const after = (await getEnvs("", demoId)).body;
  assert.equal(after.stateVersion - before.stateVersion, 1, "exactly one action appended across both confirms");
  const raced = after.environments.find((e) => e.id === target.id);
  assert.equal(raced.state, "provisioning");
});

test("unequal cached global log lengths cannot double-restart one target", async () => {
  // Regression for the rejected global-length key: instance A caches the log
  // at global length 0, an UNRELATED environment is then restarted (global
  // length 1), instance B caches at 1. Both confirm the same target. The
  // per-target epoch (0 prior restarts of the target) is the same for both,
  // so exactly one append may win - a global-length key would differ (e0 vs
  // e1) and let both through.
  const demoId = await newDemoSession();
  const dir = process.env.WORKSHOP_DATA_DIR;
  const envs = (await getEnvs("", demoId)).body.environments;
  const failed = envs.filter((e) => e.state === "failed");
  assert.ok(failed.length >= 2, "need a target and an unrelated failed environment");
  const [target, unrelated] = failed;

  const a = spawnRacer({ dir, demoId, targetId: target.id, lane: 1, preload: true });
  const readyA = await waitWorker(a.worker, "ready");
  assert.equal(readyA.stateVersion, 0, "instance A pinned at global length 0");

  // Unrelated restart: global log grows to 1 without touching the target.
  const bump = await ask({ confirm: { kind: "reprovision", ids: [unrelated.id] } }, { demoId });
  assert.equal(bump.body.executedActions[0].ok, true, JSON.stringify(bump.body).slice(0, 200));

  const b = spawnRacer({ dir, demoId, targetId: target.id, lane: 2, preload: true });
  const readyB = await waitWorker(b.worker, "ready");
  assert.equal(readyB.stateVersion, 1, "instance B pinned at global length 1");

  a.worker.postMessage("go");
  b.worker.postMessage("go");
  const [ra, rb] = await Promise.all([a.done, b.done]);
  for (const r of [ra, rb]) assert.equal(r.status, 200, JSON.stringify(r).slice(0, 300));
  const results = [ra.body, rb.body].map((body) => body.executedActions[0]);
  assert.equal(results.filter((x) => x.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((x) => !x.ok && x.skippedReason).length, 1, JSON.stringify(results));
  const files = demoActionFiles(demoId).sort();
  assert.deepEqual(files, [`${target.id}-r0.json`, `${unrelated.id}-r0.json`].sort(),
    "one event per environment; the target was not double-restarted");
});

test("overlapping bulk confirms append each environment exactly once", async () => {
  const demoId = await newDemoSession();
  const dir = process.env.WORKSHOP_DATA_DIR;
  const failed = (await getEnvs("", demoId)).body.environments.filter((e) => e.state === "failed").slice(0, 3);
  assert.equal(failed.length, 3, "demo cohort has 3 failed environments");
  const ids = failed.map((e) => e.id);
  const a = spawnRacer({ dir, demoId, targetIds: ids, lane: 1, preload: false });
  const b = spawnRacer({ dir, demoId, targetIds: ids, lane: 2, preload: false });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  for (const r of [ra, rb]) assert.equal(r.status, 200, JSON.stringify(r).slice(0, 300));
  const perId = new Map(ids.map((id) => [id, { ok: 0, skip: 0 }]));
  for (const body of [ra.body, rb.body]) {
    for (const x of body.executedActions) {
      const rec = perId.get(x.id);
      if (x.ok) rec.ok++; else if (x.skippedReason) rec.skip++;
    }
  }
  for (const [id, rec] of perId) {
    assert.deepEqual(rec, { ok: 1, skip: 1 }, `${id}: exactly one ok and one truthful skip across both bulk confirms`);
  }
  const files = demoActionFiles(demoId).sort();
  assert.deepEqual(files, ids.map((id) => `${id}-r0.json`).sort(), "each environment appended exactly once, in any order");
});

test("legacy-named event files count toward state, not per-target epochs", async () => {
  // Filename compatibility: events written under the pre-idempotency naming
  // (<at>-<id>-<uuid>.json) are merged from their stored VALUES, so they
  // raise stateVersion without changing another environment's epoch, and
  // new-format keys can never collide with legacy ones.
  const demoId = await newDemoSession();
  const dir = process.env.WORKSHOP_DATA_DIR;
  const envs = (await getEnvs("", demoId)).body.environments;
  const target = envs.find((e) => e.state === "failed");
  const other = envs.find((e) => e.id !== target.id);
  const legacyName = `1795000000000-${other.id}-3fa21c4a-9b2e-4c8a-8f1d-2e6b5a9c7d3e.json`;
  writeFileSync(join(dir, "demos", demoId, "actions", legacyName), JSON.stringify({ id: other.id, at: Date.now() }));
  const res = await ask({ confirm: { kind: "reprovision", ids: [target.id] } }, { demoId });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  assert.equal(res.body.executedActions[0].ok, true, JSON.stringify(res.body).slice(0, 200));
  const files = demoActionFiles(demoId).sort();
  assert.deepEqual(files, [legacyName, `${target.id}-r0.json`].sort(),
    "target epoch counts only the target's own prior events, from values");
  await new Promise((r) => setTimeout(r, 80)); // let the environments bundle's 50ms refresh window pass
  const after = (await getEnvs("", demoId)).body;
  assert.equal(after.stateVersion, 2, "legacy-named event is merged from its value regardless of filename");
});

test("a second identical directive finds nothing left to restart", async () => {
  const { body } = await ask({ message: "restart the failed ones" });
  assert.ok(body.executedActions.every((a) => !a.ok || a.resultingState === "provisioning"));
  assert.match(body.reply, /no failed|Skipped|nothing/i);
});

// ---------- Phase D: confirmed actions and demo-session isolation ----------

test("confirm executes revalidated actions inside the demo session only, versions pinned to the real log", async () => {
  const demoId = await newDemoSession();
  const sharedBefore = (await getEnvs()).body.stateVersion;
  const failed = (await getEnvs("states=failed", demoId)).body.environments.slice(0, 2);
  assert.equal(failed.length, 2);
  const demoBefore = (await getEnvs("", demoId)).body.stateVersion;
  const { status, body } = await ask({ confirm: { kind: "reprovision", ids: failed.map((e) => e.id) } }, { demoId });
  const demoAfter = (await getEnvs("", demoId)).body.stateVersion;
  assert.equal(status, 200);
  assert.equal(body.source, "local");
  assert.equal(body.degraded, false);
  assert.ok(body.executedActions.every((a) => a.ok && a.resultingState === "provisioning"));
  assert.equal(body.refreshRequired, true);
  assert.equal(body.stateVersion, demoBefore);
  assert.equal(body.stateVersionAfter, demoAfter);
  assert.equal(demoAfter, demoBefore + 2);
  // Shared session untouched by demo-scope actions.
  assert.equal((await getEnvs()).body.stateVersion, sharedBefore);
  // Re-confirming the same ids now skips: they are no longer failed.
  const again = await ask({ confirm: { kind: "reprovision", ids: failed.map((e) => e.id) } }, { demoId });
  assert.ok(again.body.executedActions.every((a) => !a.ok && /not failed|already/.test(a.skippedReason ?? "")));
  assert.equal(again.body.refreshRequired, false);
});

test("confirm of an unknown id reports a per-id skip", async () => {
  const { body } = await ask({ confirm: { kind: "reprovision", ids: ["env-999"] } });
  assert.equal(body.executedActions.length, 1);
  assert.equal(body.executedActions[0].ok, false);
  assert.match(body.executedActions[0].skippedReason, /unknown/i);
  assert.equal(body.refreshRequired, false);
});

test("demo session scoping applies to reads too: unknown demo id errors", async () => {
  const { status, body } = await ask({ message: "status?" }, { demoId: "123e4567-e89b-42d3-a456-426614174000" });
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "demo_not_found" });
});

// ---------- Phase F: rate limits ----------

test("message and execution buckets are enforced per client", async () => {
  const ip = freshIp();
  providerRespond = () => new Response(null, { status: 503 });
  const results = [];
  for (let i = 0; i < 21; i++) results.push((await ask({ message: "status?" }, { ip })).status);
  assert.deepEqual(results.slice(0, 20), Array(20).fill(200));
  assert.equal(results[20], 429);
});
