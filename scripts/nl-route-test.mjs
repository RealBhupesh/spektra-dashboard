// Run against the compiled Next route after npm run build. Only fetch to
// the optional provider is stubbed. No listener or credential is needed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";

for (const name of ["GROQ_API_KEY", "GROQ_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) delete process.env[name];
Object.assign(process.env, { LLM_BASE_URL: "http://127.0.0.1:3109/v1", LLM_API_KEY: "mock", LLM_MODEL: "mock" });
const require = createRequire(import.meta.url);
const { POST } = require("../.next/server/app/api/nl-filter/route.js").routeModule.userland;
const originalFetch = globalThis.fetch;
let calls = 0;
let respond;
globalThis.fetch = async (input, init) => {
  assert.equal(input, "http://127.0.0.1:3109/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  calls++;
  return respond(init);
};
after(() => { globalThis.fetch = originalFetch; });

const progress = "learners who barely made any progress";
const combined = "learners on step 4 who barely made any progress";
const providerJson = (text) => Response.json({ choices: [{ message: { content: text } }] });
const model = (f) => providerJson(JSON.stringify(f));
const send = async (text) => {
  const result = await POST(new NextRequest("http://localhost/api/nl-filter", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
  }));
  return { status: result.status, body: await result.json() };
};

const refused = async (text, response) => {
  respond = response;
  const before = calls;
  const { status, body } = await send(text);
  assert.equal(calls, before + 1);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.deepEqual(body.filter, {});
  assert.equal(body.requiresConfirmation, undefined);
  assert.equal(body.degraded, true);
  assert.match(body.message, /More filters/);
};

for (const [label, text, outcome] of [
  ["provider HTTP error", progress, () => new Response(null, { status: 503 })],
  ["malformed provider envelope", progress, () => new Response("garbage", { status: 200 })],
  ["malformed model JSON", progress, () => providerJson("{not json")],
  ["wrong content type", progress, () => Response.json({ choices: [{ message: { content: { maxProgressPct: 15 } } }] })],
  ["array instead of object", progress, () => model([{ maxProgressPct: 15 }])],
  ["unknown key", progress, () => model({ maxProgressPct: 15, run: "export" })],
  ["prototype-shaped property", progress, () => providerJson('{"maxProgressPct":15,"__proto__":{"polluted":true}}')],
  ["injection-like search text", progress, () => model({ maxProgressPct: 15, q: "<script>alert(1)</script>" })],
  ["invalid part invalidates the whole response", combined, () => model({ maxProgressPct: 15, step: 13 })],
  ["non-finite number", progress, () => providerJson('{"maxProgressPct":1e3080}')],
  ["invalid sort", progress, () => model({ maxProgressPct: 15, sort: "newest" })],
  ["sort direction without sort field", progress, () => model({ maxProgressPct: 15, order: "asc" })],
  ["strictness flag without its bound", progress, () => model({ maxProgressPct: 15, minProgressExclusive: true })],
  ["strict equal bounds conflict", progress, () => model({ maxProgressPct: 15, minProgressPct: 15, minProgressExclusive: true })],
  ["missing one explicit conjunct", combined, () => model({ maxProgressPct: 15 })],
  ["changed an explicit step", combined, () => model({ maxProgressPct: 15, step: 5 })],
  ["changed a strict explicit threshold", "learners below 25% on step 4 who barely progressed", () => model({ maxProgressPct: 25, step: 4 })],
  ["drops a second recognized topic", "learners who crashed and barely made progress", () => model({ maxProgressPct: 15 })],
  ["adds an unrelated state", progress, () => model({ maxProgressPct: 15, states: ["ready"] })],
]) {
  test(label, () => refused(text, outcome));
}

test("provider timeout aborts the request and leaves manual alternatives", { timeout: 12_000 }, async () => {
  let aborted = false;
  await refused(progress, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  assert.equal(aborted, true);
});

test("valid suggestion recovers after failure and always requires confirmation", async () => {
  respond = () => model({ maxProgressPct: 15, step: 4 });
  const { status, body } = await send(combined);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.source, "llm");
  assert.equal(body.requiresConfirmation, true);
  assert.deepEqual(body.filter, { sort: "risk", maxProgressPct: 15, step: 4 });
  assert.deepEqual(body.description, ["on step 4", "progress at most 15%"]);
});

test("sort order in description matches accepted model query", async () => {
  respond = () => model({ sort: "progress", order: "asc" });
  const { body } = await send("sort by progress lowest first");
  assert.equal(body.requiresConfirmation, true);
  assert.equal(body.filter.order, "asc");
  assert.deepEqual(body.description, ["sorted by progress, lowest first"]);
});

test("canonical query, terminal refusals and oversized query skip provider", async () => {
  const before = calls;
  const { body } = await send("everyone stuck on step 4 over 20 min");
  assert.equal(body.ok, true);
  assert.equal(body.source, "local-parser");
  assert.equal(body.filter.minStepMinutesExclusive, true);
  for (const query of ["step 13 and barely progressed", "under 130% and barely progressed", "failed on step 4 and step 5", "not failed", "failed 999"]) {
    const { body } = await send(query);
    assert.equal(body.terminal, true, query);
    assert.deepEqual(body.filter, {});
  }
  assert.equal((await send("failed " + "x".repeat(295))).status, 400);
  assert.equal(calls, before);
});

test("unconfigured provider retains offline guidance", async () => {
  delete process.env.LLM_BASE_URL;
  const before = calls;
  const { body } = await send(progress);
  assert.equal(body.source, "local-parser");
  assert.equal(body.ok, false);
  assert.equal(calls, before);
});
