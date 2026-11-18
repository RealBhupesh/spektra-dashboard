// Regression tests for the deterministic simulation engine and the offline
// NL compiler. These run WITHOUT a server: lib/ is compiled to plain JS and
// exercised directly, so time-based behavior is asserted exactly instead of
// by waiting on wall-clock.
// Usage: node scripts/sim-test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = mkdtempSync(path.join(tmpdir(), "simbuild-"));
process.on("exit", () => rmSync(out, { recursive: true, force: true }));
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "lib/replay.ts", "lib/seed.ts", "lib/types.ts", "lib/prng.ts", "lib/filters.ts", "lib/nlparser.ts",
   "--outDir", out, "--module", "commonjs", "--target", "es2020", "--moduleResolution", "node", "--skipLibCheck", "--esModuleInterop"],
  { stdio: "inherit" },
);

const { computeState, SEED } = await import(path.join(out, "replay.js"));
const { seedEnvironments } = await import(path.join(out, "seed.js"));
const { applyFilter, progressPct, spendUsd, isStuck } = await import(path.join(out, "filters.js"));
const { compileNL } = await import(path.join(out, "nlparser.js"));

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
};

const T0 = 1_800_000_000_000; // fixed fake session anchor
const H = 3_600_000;

// 1. Determinism: identical inputs -> byte-identical output (cold-start safe)
const seeds = () => seedEnvironments(SEED, T0);
const a = computeState(seeds(), T0, [], T0 + 2 * H);
const b = computeState(seeds(), T0, [], T0 + 2 * H);
ok("same inputs produce identical state (cold-start consistency)", JSON.stringify(a) === JSON.stringify(b));

// 2. Gap length does not matter: computing at T+5h directly equals a
//    hypothetical hour-by-hour replay, because billing accrues per segment.
const direct = computeState(seeds(), T0, [], T0 + 5 * H);
const spendAt = (t) => computeState(seeds(), T0, [], t).reduce((s, e) => s + spendUsd(e), 0);
ok("spend is monotonic in time", spendAt(T0 + 5 * H) > spendAt(T0 + H), `${spendAt(T0 + H)} -> ${spendAt(T0 + 5 * H)}`);
ok("long-gap compute equals itself across calls (no drift)", JSON.stringify(direct) === JSON.stringify(computeState(seeds(), T0, [], T0 + 5 * H)));

// 3. Billing stops at the simulated deprovision time, not at the poll time
const later1 = computeState(seeds(), T0, [], T0 + 24 * H);
const later2 = computeState(seeds(), T0, [], T0 + 48 * H);
const deprov = later1.filter((e) => e.state === "deprovisioned");
ok("some learners finish within 24h", deprov.length > 0, `got ${deprov.length}`);
const billed = later1.filter((e) => {
  const twin = later2.find((x) => x.id === e.id);
  return e.state === "deprovisioned" && twin.runtimeMinutes !== e.runtimeMinutes;
});
ok("no deprovisioned environment accrues further runtime", billed.length === 0, billed.map((e) => e.id).join(","));

// 4. Reprovision log applies deterministically: failed env leaves failed state
const atT = computeState(seeds(), T0, [], T0 + 30 * 60_000);
const failedOne = atT.find((e) => e.state === "failed");
ok("seed produces failed environments", !!failedOne);
const withLog = computeState(seeds(), T0, [{ id: failedOne.id, at: T0 + 30 * 60_000 }], T0 + 30 * 60_000 + 1000);
const after = withLog.find((e) => e.id === failedOne.id);
ok("reprovisioned env is provisioning the instant after the action", after.state === "provisioning", after.state);
const grown = computeState(seeds(), T0, [{ id: failedOne.id, at: T0 + 30 * 60_000 }], T0 + 5 * H).find((e) => e.id === failedOne.id);
ok("reprovisioned env lives a new deterministic life", ["provisioning", "ready", "in_use", "failed", "deprovisioned"].includes(grown.state), grown.state);
const olderSnapshot = computeState(seeds(), T0, [{ id: failedOne.id, at: T0 + 30 * 60_000 + 1 }], T0 + 30 * 60_000);
ok("a snapshot ignores actions dated after its clock", JSON.stringify(olderSnapshot) === JSON.stringify(atT));

// 5. Stuck cohort exists near session start (seeded) and the signal persists
const nearStart = computeState(seeds(), T0, [], T0 + 60_000);
const stuck0 = nearStart.filter((e) => isStuck(e, T0 + 60_000)).length;
ok("stuck cohort visible at session start", stuck0 >= 5, `got ${stuck0}`);

// 6. Progress semantics: entering step 12 is 92%, not 100%; only finished is 100
const step12 = { id: "x", learnerName: "T", learnerEmail: "t", state: "in_use", step: 12, totalSteps: 12, stepStartedAt: 0, startedAt: 0, runtimeMinutes: 10, ratePerHour: 2, failureReason: null };
ok("on step 12 shows 92%, not 100%", progressPct(step12) === 92, `${progressPct(step12)}`);
ok("deprovisioned shows 100%", progressPct({ ...step12, state: "deprovisioned" }) === 100);
ok("failed on step 12 keeps 92%", progressPct({ ...step12, state: "failed" }) === 92);

// 7. NL compiler: negation abstains instead of inverting intent
const neg = compileNL("not failed");
ok('"not failed" abstains', !neg.ok && /negation/i.test(neg.message), neg.message);

// 8. NL compiler: name + state clauses combine
const combo = compileNL("failed learner named Priya");
ok("name + state combine", combo.ok && combo.filter.q === "Priya" && combo.filter.states?.includes("failed"), JSON.stringify(combo.filter));

// 9. NL compiler: unknown words abstain instead of being dropped
const unknown = compileNL("stuck on step 4 sparkling");
ok("unknown word abstains", !unknown.ok && /sparkling/.test(unknown.message), unknown.message);

// 10. Strict vs inclusive operators survive compilation
const under = compileNL("under 25%");
ok('"under 25%" is exclusive', under.ok && under.filter.maxProgressPct === 25 && under.filter.maxProgressExclusive === true, JSON.stringify(under.filter));
const atLeast = compileNL("at least 50% done");
ok('"at least 50%" is inclusive', atLeast.ok && atLeast.filter.minProgressPct === 50 && !atLeast.filter.minProgressExclusive, JSON.stringify(atLeast.filter));
const over = compileNL("over 50% done");
ok('"over 50%" is exclusive', over.ok && over.filter.minProgressExclusive === true, JSON.stringify(over.filter));

// 11. Canonical phrasings still compile (regression net)
for (const q of ["failed", "everyone stuck on step 4 over 20 min", "costing over $8", "who is costing the most"]) {
  const r = compileNL(q);
  ok(`compiles: "${q}"`, r.ok, r.message);
}

for (const query of [
  "failed on step 13",
  "step 0",
  "failed on step 4.5",
  "under 130%",
  "under -10%",
  "failed on step 4 and step 5",
  "failed over 20 minutes and over 60 minutes",
  "failed under 25% and over 50%",
  "at least 25% and under 25%",
  "over 100%",
  "failed 999",
  "failed $",
  "costing over $5k",
  "failed under 25%ish",
  "failed and ready",
  "failed or stuck under 40%",
  "isn't failed",
  "named Priya and named Alex",
]) {
  const r = compileNL(query);
  ok(`terminal refusal: ${query}`, !r.ok && r.terminal === true && Object.keys(r.filter).length === 0, r.message);
}

const name = compileNL("failed learner named Priya   Sharma on step 4.");
ok("name preserves its boundaries before a step qualifier", name.ok && name.filter.q === "Priya Sharma" && name.filter.step === 4);
const states = compileNL("ready or failed");
ok("or connects two state alternatives", states.ok && states.filter.states?.join(",") === "ready,failed");
const exactly = { ...step12, step: 4, runtimeMinutes: 60, ratePerHour: 5 };
const boundaryTime = 20 * 60_000;
for (const [query, count] of [
  ["25% or less", 1], ["under 25%", 0], ["at most 25% and at least 25%", 1],
  ["at least 20 minutes", 1], ["over 20 minutes", 0],
  ["at least $5", 1], ["over $5", 0],
]) {
  const r = compileNL(query);
  ok(`compiles and filters threshold: ${query}`, r.ok && applyFilter([exactly], r.filter, boundaryTime).length === count, r.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
