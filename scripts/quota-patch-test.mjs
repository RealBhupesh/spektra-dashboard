// Quota-patch regression tests for lib/persistence.ts.
// Compiles lib/ to plain JS, replaces @vercel/blob with an in-memory stub
// (seeded into require.cache BEFORE the compiled module is loaded) and stubs
// global fetch for blob downloads. No network is touched. Every blob SDK call
// is counted, classified (advanced vs simple per Vercel's pricing doc:
// put/list = advanced, head/download = simple), and asserted exactly.
// Usage: node scripts/quota-patch-test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(path.join(projectRoot, "scripts", "x.mjs"));

// Compile inside the project so the compiled output resolves node_modules.
const out = path.join(projectRoot, ".quota-build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
process.on("exit", () => rmSync(out, { recursive: true, force: true }));
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc",
    "lib/persistence.ts", "lib/store.ts", "lib/replay.ts", "lib/seed.ts", "lib/types.ts", "lib/prng.ts", "lib/filters.ts",
    "--outDir", out, "--module", "commonjs", "--target", "es2020", "--moduleResolution", "node", "--skipLibCheck", "--esModuleInterop"],
  { stdio: "inherit", cwd: projectRoot },
);

// ---------- In-memory fake blob store ----------
const FAKE_HOST = "https://fake-store.blob.vercel-storage.com";
const store = new Map(); // pathname -> body string
const calls = { put: 0, list: 0, head: 0, download: 0 };
let storeDown = false;

class BlobNotFoundError extends Error {
  constructor() {
    super("The requested blob does not exist");
    this.name = "BlobNotFoundError";
  }
}
const download = (pathname) => `${FAKE_HOST}/${encodeURIComponent(pathname)}?download=1`;
const blobStub = {
  BlobNotFoundError,
  async put(pathname, body, opts = {}) {
    calls.put++;
    if (storeDown) throw new Error("blob service unavailable");
    if (opts.allowOverwrite === false && store.has(pathname)) {
      const err = new Error("precondition_failed: blob already exists");
      err.code = "precondition_failed";
      throw err;
    }
    store.set(pathname, String(body));
    return { url: `${FAKE_HOST}/${encodeURIComponent(pathname)}`, downloadUrl: download(pathname), pathname };
  },
  async list({ prefix = "", limit = 1000, cursor } = {}) {
    calls.list++;
    if (storeDown) throw new Error("blob service unavailable");
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      .map((pathname) => ({ pathname, downloadUrl: download(pathname) }));
    const startAt = cursor ? Number(cursor) : 0;
    const page = all.slice(startAt, startAt + limit);
    const end = startAt + limit;
    return { blobs: page, hasMore: end < all.length, cursor: end < all.length ? String(end) : undefined };
  },
  async head(pathname) {
    calls.head++;
    if (storeDown) throw new Error("blob service unavailable");
    if (!store.has(pathname)) throw new BlobNotFoundError();
    return {
      url: `${FAKE_HOST}/${encodeURIComponent(pathname)}`,
      downloadUrl: download(pathname),
      pathname,
      size: store.get(pathname).length,
      contentType: "application/json",
      contentDisposition: "inline",
      cacheControl: "no-cache",
      uploadedAt: new Date(),
      etag: "stub",
    };
  },
};
const blobResolved = require.resolve("@vercel/blob", { paths: [out] });
const blobModule = new Module(blobResolved, null);
blobModule.exports = blobStub;
blobModule.loaded = true;
require.cache[blobResolved] = blobModule;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.startsWith(FAKE_HOST)) throw new Error(`network disabled in tests: ${u.slice(0, 80)}`);
  calls.download++;
  if (storeDown) return { ok: false, status: 503, json: async () => ({}) };
  const pathname = decodeURIComponent(new URL(u).pathname.slice(1));
  if (!store.has(pathname)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(store.get(pathname)) };
};
process.on("exit", () => { globalThis.fetch = realFetch; });

// ---------- Environment: blob backend, tiny refresh window ----------
process.env.BLOB_READ_WRITE_TOKEN = "test-token-not-real";
process.env.PERSIST_REFRESH_MS = "50";
delete process.env.WORKSHOP_DATA_DIR;

const persistence = await import(path.join(out, "persistence.js"));
const {
  loadPersisted, saveAnchor, appendAction,
  createDemoSession, loadDemoSession, appendDemoAction,
  resetPersistenceCache, DEMO_LIFETIME_MS,
} = persistence;

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
};
const snap = () => ({ ...calls });
const diff = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));
const uuid = () => crypto.randomUUID();

// T1 cold shared boot: head (simple) for anchor, one list (advanced) for actions
resetPersistenceCache();
let s = snap();
ok("T1 first boot: store never anchored returns null", (await loadPersisted()) === null);
let d = diff(s, snap());
ok("T1 first boot used head+list, no put/download", d.head === 1 && d.list === 1 && d.put === 0 && d.download === 0, JSON.stringify(d));

s = snap();
await saveAnchor(1_000_000);
d = diff(s, snap());
ok("T1 anchor write is exactly one put", d.put === 1 && d.list === 0 && d.head === 0, JSON.stringify(d));

// T2 warm shared load within TTL: zero store calls
s = snap();
const warm = await loadPersisted();
ok("T2 warm load returns anchor", warm && warm.sessionStartedAt === 1_000_000);
d = diff(s, snap());
ok("T2 warm load within TTL made zero blob calls", d.head === 0 && d.list === 0 && d.put === 0 && d.download === 0, JSON.stringify(d));

// T3 shared refresh after TTL: only the actions list (anchor already cached)
await delay(70);
s = snap();
await loadPersisted();
d = diff(s, snap());
ok("T3 refresh after TTL = one list, anchor NOT re-read", d.list === 1 && d.head === 0 && d.download === 0, JSON.stringify(d));

// T3b shared append: one put, same-instance read-after-write from cache
s = snap();
const evShared = { id: "env-shared-1", at: 1_000_100 };
ok("T3b shared append succeeds", await appendAction(evShared));
d = diff(s, snap());
ok("T3b shared append = one put, nothing else", d.put === 1 && d.list === 0 && d.head === 0, JSON.stringify(d));
const afterAppend = await loadPersisted();
ok("T3b same instance reads own write with zero store calls", afterAppend.reprovisionLog.some((e) => e.id === "env-shared-1") && JSON.stringify(diff(s, snap())) === JSON.stringify({ put: 1, list: 0, head: 0, download: 0 }));

// T4 demo create + immediate load: one put for the anchor, then zero calls
resetPersistenceCache();
s = snap();
const demoA = await createDemoSession(2_000_000);
d = diff(s, snap());
ok("T4 demo creation = one put (anchor)", d.put === 1 && d.list === 0 && d.head === 0, JSON.stringify(d));
s = snap();
const demoLoad = await loadDemoSession(demoA.id, 2_000_100);
d = diff(s, snap());
ok("T4 demo load within TTL: zero blob calls (creating instance already knows state)", d.head === 0 && d.list === 0 && d.put === 0 && d.download === 0, JSON.stringify(d));
ok("T4 demo load returns the anchor", demoLoad.sessionStartedAt === 2_000_000 && demoLoad.reprovisionLog.length === 0);

// T5 demo refresh after TTL: one head + one list + the anchor body download
// (head returns metadata only; the anchor JSON is a CDN download - both are
// simple operations; only the list is advanced)
await delay(70);
s = snap();
await loadDemoSession(demoA.id, 2_000_200);
d = diff(s, snap());
ok("T5 demo refresh after TTL = one head + one list + anchor download only", d.head === 1 && d.list === 1 && d.download === 1 && d.put === 0, JSON.stringify(d));

// T6 demo append: one put; same-instance read-after-write with zero further calls
s = snap();
ok("T6 demo append succeeds", await appendDemoAction(demoA.id, { id: "env-a-1", at: 2_000_300 }));
const demoAfter = await loadDemoSession(demoA.id, 2_000_400);
d = diff(s, snap());
ok("T6 demo append = one put; reload within TTL adds zero calls and sees the action",
  d.put === 1 && d.head === 0 && d.list === 0 && d.download === 0 && demoAfter.reprovisionLog.some((e) => e.id === "env-a-1"),
  JSON.stringify(d));

// T7 cross-instance: a fresh instance discovers both demo actions, downloading each once
await appendDemoAction(demoA.id, { id: "env-a-2", at: 2_000_500 });
resetPersistenceCache(); // simulate a different lambda instance
s = snap();
const coldDemo = await loadDemoSession(demoA.id, 2_000_600);
d = diff(s, snap());
ok("T7 cold instance demo load = one head + one list + anchor download + one download per unknown action",
  d.head === 1 && d.list === 1 && d.download === 3 && d.put === 0, JSON.stringify(d));
ok("T7 cold instance sees both actions", coldDemo.reprovisionLog.length === 2);

// T8a store down + warm demo cache: stale is served (same rule as the shared session)
storeDown = true;
await delay(70);
const stale = await loadDemoSession(demoA.id, 2_000_700);
ok("T8a store down + warm cache serves stale state", stale.reprovisionLog.length === 2);

// T8b store down + cold: visible failure, never a silent reset
resetPersistenceCache();
let threw = null;
try { await loadDemoSession(demoA.id, 2_000_800); } catch (e) { threw = e; }
ok("T8b store down + cold cache throws PersistUnavailable", threw && threw.name === "PersistUnavailable", threw && threw.message);
storeDown = false;

// T8c expired demo: 410 served from a warm cache without touching the store
await loadDemoSession(demoA.id, 2_000_850); // re-warm the cache (T8b cleared it)
s = snap();
threw = null;
try { await loadDemoSession(demoA.id, 2_000_000 + DEMO_LIFETIME_MS + 1); } catch (e) { threw = e; }
d = diff(s, snap());
ok("T8c expired demo -> demo_expired (410), zero store calls", threw && threw.code === "demo_expired" && threw.status === 410 && d.head === 0 && d.list === 0, threw && threw.code);
resetPersistenceCache();
threw = null;
try { await loadDemoSession(demoA.id, 2_000_000 + DEMO_LIFETIME_MS + 1); } catch (e) { threw = e; }
ok("T8c expired demo on cold instance -> demo_expired (410)", threw && threw.code === "demo_expired" && threw.status === 410);

// T8d unknown + malformed ids: 404s
threw = null;
try { await loadDemoSession(uuid(), 2_100_000); } catch (e) { threw = e; }
ok("T8d unknown demo id -> demo_not_found (404)", threw && threw.code === "demo_not_found" && threw.status === 404);
threw = null;
try { await loadDemoSession("../../etc/passwd", 2_100_000); } catch (e) { threw = e; }
ok("T8d malformed demo id -> demo_not_found (404)", threw && threw.code === "demo_not_found" && threw.status === 404);

// T8e failed append reports false and does NOT enter the cache
storeDown = true;
resetPersistenceCache();
const demoB = await createDemoSession(3_000_000).catch(() => null);
storeDown = false;
ok("T8e create during outage rejects (visible failure)", demoB === null);
const demoC = await createDemoSession(3_000_000);
storeDown = true;
const appendResult = await appendDemoAction(demoC.id, { id: "env-c-1", at: 3_000_100 });
storeDown = false;
ok("T8e failed append returns false", appendResult === false);
const demoCLoad = await loadDemoSession(demoC.id, 3_000_200);
ok("T8e failed append is not served from cache as if saved", demoCLoad.reprovisionLog.length === 0);

// T9 demo isolation: two demos never share state
const demoD = await createDemoSession(4_000_000);
await appendDemoAction(demoD.id, { id: "env-d-1", at: 4_000_100 });
const demoAReload = await loadDemoSession(demoA.id, 2_000_900);
ok("T9 demo A unchanged by demo D writes", demoAReload.reprovisionLog.every((e) => e.id.startsWith("env-a-")) && demoAReload.reprovisionLog.length === 2);
resetPersistenceCache();
const demoDCold = await loadDemoSession(demoD.id, 4_000_200);
ok("T9 cold load of demo D sees only its own action", demoDCold.reprovisionLog.length === 1 && demoDCold.reprovisionLog[0].id === "env-d-1");

// T10 stateVersion: the append-only log length is the reconciliation signal.
const storeModule = await import(path.join(out, "store.js"));
resetPersistenceCache();
let v = (await storeModule.getSnapshot(Date.now(), null)).stateVersion;
ok("T10 shared snapshot version equals the persisted log length", v === 1, `got ${v}`); // one shared action from T3b
s = snap();
await appendAction({ id: "env-shared-2", at: 1_001_000 });
v = (await storeModule.getSnapshot(Date.now(), null)).stateVersion;
d = diff(s, snap());
ok("T10 same-instance append raises the version with zero extra reads", v === 2 && d.put === 1 && d.list === 0 && d.head === 0, JSON.stringify(d));
resetPersistenceCache();
s = snap();
v = (await storeModule.getSnapshot(Date.now(), null)).stateVersion;
d = diff(s, snap());
ok("T10 cold instance recovers the same version (head for anchor + 1 list + anchor download + 1 download per unknown action)", v === 2 && d.list === 1 && d.head === 1 && d.download === 3, JSON.stringify(d));
const sharedSnap = await storeModule.getSnapshot(Date.now(), null);
ok("T10 shared snapshots also carry the action log for inclusion gating", sharedSnap.actions.length === 2 && sharedSnap.actions.some((x) => x.id === "env-shared-1") && sharedSnap.actions.some((x) => x.id === "env-shared-2"));
const demoVSnap = await storeModule.getSnapshot(4_000_300, demoD.id);
ok("T10 demo snapshot version tracks the demo log only", demoVSnap.stateVersion === 1, `got ${demoVSnap.stateVersion}`);

// T11 reprovision returns the exact appended action; snapshots carry the log
// as the client's inclusion proof. Uses a fresh demo so a failed env exists.
const nowReal = Date.now();
const demoE = await createDemoSession(nowReal);
const snapE = await storeModule.getSnapshot(nowReal + 1000, demoE.id);
const failedE = snapE.environments.find((x) => x.state === "failed");
ok("T11 fresh demo has a failed env to act on", Boolean(failedE));
const rr = await storeModule.reprovision(failedE.id, nowReal + 2000, demoE.id);
ok("T11 reprovision returns the appended action event", Boolean(rr && rr.action && rr.action.id === failedE.id && rr.action.at === nowReal + 2000 && rr.stateVersion === 1));
const snapE2 = await storeModule.getSnapshot(nowReal + 3000, demoE.id);
ok("T11 snapshot includes the confirmed action (inclusion proof)", snapE2.actions.some((x) => x.id === failedE.id && x.at === nowReal + 2000));
const noop = await storeModule.reprovision(failedE.id, nowReal + 4000, demoE.id);
ok("T11 no-op reprovision returns action null with unchanged version", Boolean(noop && noop.action === null && noop.stateVersion === 1));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
