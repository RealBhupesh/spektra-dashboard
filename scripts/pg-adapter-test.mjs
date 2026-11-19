// Postgres backend tests for lib/persistence.ts via lib/sqlstore.ts.
// Uses an embedded Postgres (PGlite, SQL_DRIVER=pglite). Production uses Neon
// over HTTP with the same SQL. "Instances" are simulated by dropping the
// in-process cache; the database is the only shared thing. Usage: node scripts/pg-adapter-test.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(path.join(root, "scripts", "x.mjs"));
const out = path.join(root, ".pg-build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
process.on("exit", () => rmSync(out, { recursive: true, force: true }));
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "lib/persistence.ts", "lib/sqlstore.ts", "lib/replay.ts", "lib/seed.ts", "lib/types.ts", "lib/prng.ts", "lib/filters.ts", "--outDir", out, "--module", "commonjs", "--target", "es2020", "--moduleResolution", "node", "--skipLibCheck", "--esModuleInterop"], { stdio: "inherit", cwd: root });

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}${c ? "" : " " + x}`); };
const ev = (id, at) => ({ id, at, kind: "reprovision" });

delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.SQL_DRIVER = "pglite";
const P = require(path.join(out, "persistence.js"));
const S = require(path.join(out, "sqlstore.js"));

ok("first boot: store reachable but never anchored returns null", (await P.loadPersisted()) === null);
const [a1, a2] = await Promise.all([P.saveAnchor(1000), P.saveAnchor(2000)]);
ok("concurrent first boots adopt one anchor", a1 === a2, `${a1} ${a2}`);
const anchor = a1;
P.resetPersistenceCache();
ok("a fresh instance reads the same anchor", (await P.loadPersisted())?.sessionStartedAt === anchor);

ok("append saves", (await P.appendAction(ev("env-1", 10), 0)) === "saved");
P.resetPersistenceCache();
let l = await P.loadPersisted();
ok("action survives instance loss (durable) and is visible to another instance", l.reprovisionLog.length === 1 && l.reprovisionLog[0].id === "env-1");
// Unique-key conflict fixture: two in-flight appends of the SAME env at the
// SAME per-target epoch hit the real unique constraint - exactly one saved.
const res = await Promise.all([P.appendAction(ev("env-2", 20), 0), P.appendAction(ev("env-2", 20), 0), P.appendAction(ev("env-3", 20), 0)]);
ok("concurrent same-target same-epoch appends: exactly one saved, one conflict", res[2] === "saved" && res.slice(0, 2).sort().join(",") === "conflict,saved", res.join(","));
P.resetPersistenceCache();
l = await P.loadPersisted();
ok("no lost update: 3 actions stored (the duplicate env-2 append conflicted)", l.reprovisionLog.length === 3, String(l.reprovisionLog.length));
ok("log is ordered by time", l.reprovisionLog.every((e, i, a) => i === 0 || a[i - 1].at <= e.at));
ok("legitimate re-restart uses the next per-target epoch", (await P.appendAction(ev("env-2", 25), 1)) === "saved");
ok("same re-restart epoch conflicts on retry", (await P.appendAction(ev("env-2", 26), 1)) === "conflict");
// Legacy filename compatibility: an event written under the pre-idempotency
// <at>-<id>-<uuid>.json naming merges from its VALUE, raises the log length,
// and does not collide with or shift new-format per-target epoch keys.
const legacyKey = "cloudlabs-ops/actions/1795000000000-env-4-3fa21c4a-9b2e-4c8a-8f1d-2e6b5a9c7d3e.json";
ok("legacy-named event can be inserted", (await S.kvPutNew(legacyKey, ev("env-4", 15))) === true);
P.resetPersistenceCache();
l = await P.loadPersisted();
ok("legacy-named event merges from its value", l.reprovisionLog.length === 5 && l.reprovisionLog.some((e) => e.id === "env-4"), String(l.reprovisionLog.length));
ok("post-legacy epoch-1 append of env-4 saves under a non-colliding key", (await P.appendAction(ev("env-4", 30), 1)) === "saved");
ok("kvPutNew never overwrites an existing key", (await S.kvPutNew("t/k", { a: 1 })) === true && (await S.kvPutNew("t/k", { a: 2 })) === false && (await S.kvGet("t/k")).a === 1);
ok("kvList is prefix-exact", (await S.kvList("t/")).length === 1 && (await S.kvList("tt/")).length === 0);

// isolated demo sessions
const now = Date.now();
const d = await P.createDemoSession(now);
ok("demo session created", typeof d.id === "string");
ok("demo append saves", (await P.appendDemoAction(d.id, ev("env-9", now + 5), 0)) === "saved");
ok("demo same-target same-epoch append conflicts", (await P.appendDemoAction(d.id, ev("env-9", now + 6), 0)) === "conflict");
P.resetPersistenceCache();
const dl = await P.loadDemoSession(d.id, now + 10);
ok("demo state durable across instances (conflicted duplicate not stored)", dl.reprovisionLog.length === 1 && dl.sessionStartedAt === now);
ok("demo is isolated from the shared session", (await P.loadPersisted()).reprovisionLog.every((e) => e.id !== "env-9"));
let err = null;
try { await P.loadDemoSession("11111111-1111-4111-8111-111111111111", now); } catch (e) { err = e; }
ok("unknown demo id is demo_not_found", err?.code === "demo_not_found", String(err));
err = null;
try { await P.loadDemoSession(d.id, now + P.DEMO_LIFETIME_MS + 1); } catch (e) { err = e; }
ok("expired demo is demo_expired", err?.code === "demo_expired", String(err));
err = null;
try { await P.loadDemoSession("not-a-uuid", now); } catch (e) { err = e; }
ok("malformed demo id rejected before any query", err?.code === "demo_not_found");

// restart durability on disk: two separate OS processes, same PGlite directory
const dir = mkdtempSync(path.join(tmpdir(), "pgl-"));
const child = (code) => execFileSync(process.execPath, ["-e", code], { cwd: root, env: { ...process.env, SQL_DRIVER: "pglite", PGLITE_DIR: dir } }).toString().trim();
const pre = `const P=require(${JSON.stringify(path.join(out, "persistence.js"))});`;
child(pre + "(async()=>{await P.saveAnchor(777);await P.appendAction({id:'env-5',at:5,kind:'reprovision'}, 0);process.exit(0)})()");
const back = child(pre + "(async()=>{const l=await P.loadPersisted();console.log(JSON.stringify([l.sessionStartedAt,l.reprovisionLog.length]));process.exit(0)})()");
ok("anchor and action survive a full process restart", back.split("\n").pop() === "[777,1]", back);
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
