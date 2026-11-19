import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { put, list, head, BlobNotFoundError } from "@vercel/blob";
import { ReprovisionEvent } from "./replay";
import { kvGet, kvList, kvPutNew, sqlConfigured } from "./sqlstore";

// The simulation itself is derivable (lib/replay.ts), so the only state that
// must survive a cold start is the session anchor and the operator's
// reprovision actions. Design notes:
//   - The log is APPEND-ONLY: one object per action, unique key, never
//     overwritten. Two instances writing concurrently can never clobber each
//     other (no read-modify-write of a shared document, so no lost updates).
//   - Warm instances REFRESH from the shared store every REFRESH_TTL_MS and
//     merge by key, so actions taken through one instance become visible to
//     every other instance within that window. Isolated demo sessions are
//     cached per instance under the same TTL and the same merge-by-key rule.
//   - Blob operation budget (Hobby allowance: advanced ops are the scarce
//     one): anchor reads use head() on the known key, a simple operation;
//     list() (an advanced operation) runs at most once per refresh window
//     per session per instance, and only to discover keys written by OTHER
//     instances - a manifest read would be a read-modify-write and would
//     lose the append-only no-lost-update property, so list stays.
//   - Failures are visible: a mutation that cannot be written fails the
//     request (the UI shows it) instead of pretending to save, and a cold
//     instance that cannot read the store answers 503 instead of silently
//     resetting to the seed.
// Backends: private Vercel Blob when configured, or a local directory.
export interface Persisted {
  sessionStartedAt: number;
  reprovisionLog: ReprovisionEvent[];
}

export class PersistUnavailable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PersistUnavailable";
  }
}

const DATA_DIR = path.resolve(process.env.WORKSHOP_DATA_DIR || ".data");
const ANCHOR_FILE = path.join(DATA_DIR, "anchor.json");
const ACTIONS_DIR = path.join(DATA_DIR, "actions");
const ANCHOR_PATH = "cloudlabs-ops/anchor.json";
const ACTIONS_PREFIX = "cloudlabs-ops/actions/";
export const DEMO_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class DemoSessionError extends Error {
  constructor(readonly code: "demo_not_found" | "demo_expired") {
    super(code);
    this.name = "DemoSessionError";
  }

  get status() { return this.code === "demo_expired" ? 410 : 404; }
}

// Polls between refreshes are served from process memory; other instances'
// actions surface within this window. Tests override via PERSIST_REFRESH_MS.
const configuredTtl = Number(process.env.PERSIST_REFRESH_MS);
const REFRESH_TTL_MS = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 30_000;

// Generated once per serverless process. Runtime logs carry it so a request
// served by a fresh process (cold start) is distinguishable in the logs.
const INSTANCE_ID = randomUUID().slice(0, 8);
const slog = (msg: string) => console.log(`[persistence] instance=${INSTANCE_ID} ${msg}`);

interface Mem {
  anchor: number;
  actions: Map<string, ReprovisionEvent>; // key: storage key (blob pathname or filename)
}

let mem: Mem | null = null;
let lastRefreshAt = 0;

const usePg = () => sqlConfigured();
const useBlob = () => !usePg() && Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function toPersisted(m: Mem): Persisted {
  return {
    sessionStartedAt: m.anchor,
    reprovisionLog: [...m.actions.values()].sort((a, b) => a.at - b.at),
  };
}

function validAction(v: unknown): v is ReprovisionEvent {
  const e = v as ReprovisionEvent;
  return Boolean(e && typeof e.id === "string" && typeof e.at === "number");
}

// ---------- Blob backend ----------

async function blobFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`blob download ${res.status}`);
  return res.json();
}

async function blobReadAnchor(pathname = ANCHOR_PATH): Promise<number | null> {
  // head() reads metadata for a KNOWN key and is billed as a simple
  // operation; a list() here would be an advanced operation on every read.
  // Explicit token: without it the SDK prefers the auto-injected OIDC
  // credentials, which this store connection does not allow for writes.
  try {
    const meta = await head(pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const raw = (await blobFetchJson(meta.downloadUrl)) as { sessionStartedAt?: number };
    return typeof raw.sessionStartedAt === "number" ? raw.sessionStartedAt : null;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

async function blobListActions(prefix = ACTIONS_PREFIX): Promise<{ pathname: string; downloadUrl: string }[]> {
  const out: { pathname: string; downloadUrl: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, limit: 1000, cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
    out.push(...page.blobs.map((b) => ({ pathname: b.pathname, downloadUrl: b.downloadUrl })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function blobRefresh(): Promise<number | null> {
  const anchor = mem?.anchor ?? (await blobReadAnchor());
  const entries = await blobListActions();
  const actions = mem?.actions ?? new Map<string, ReprovisionEvent>();
  let added = 0;
  for (const e of entries) {
    if (actions.has(e.pathname)) continue;
    const v = await blobFetchJson(e.downloadUrl);
    if (validAction(v)) {
      actions.set(e.pathname, v);
      added++;
    }
  }
  if (anchor !== null) {
    mem = { anchor, actions };
    lastRefreshAt = Date.now();
  }
  slog(`source=blob actions=${actions.size} (+${added})`);
  return anchor;
}

async function blobWriteAnchor(anchor: number, pathname = ANCHOR_PATH): Promise<number> {
  try {
    await put(pathname, JSON.stringify({ sessionStartedAt: anchor }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return anchor;
  } catch (err) {
    // Concurrent first boots race the anchor write; the loser adopts the
    // winner's anchor so every instance replays the same session.
    const existing = await blobReadAnchor(pathname).catch(() => null);
    if (existing !== null) return existing;
    throw err;
  }
}

// Returns the storage key written, or null when the action was NOT saved.
// Callers update their own caches with the key and must fail the request
// visibly on null instead of reporting an ephemeral change.
async function blobAppendAction(ev: ReprovisionEvent, prefix = ACTIONS_PREFIX): Promise<string | null> {
  const key = `${prefix}${ev.at}-${ev.id}-${randomUUID()}.json`;
  try {
    await put(key, JSON.stringify(ev), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return key;
  } catch (err) {
    console.error(`[persistence] instance=${INSTANCE_ID} append failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------- Postgres backend (Neon) ----------

async function pgReadAnchor(key = ANCHOR_PATH): Promise<number | null> {
  const raw = (await kvGet(key)) as { sessionStartedAt?: number } | null;
  return raw && typeof raw.sessionStartedAt === "number" ? raw.sessionStartedAt : null;
}

async function pgWriteAnchor(anchor: number, key = ANCHOR_PATH): Promise<number> {
  // Concurrent first boots race: the unique key lets exactly one insert win and
  // every loser adopts the stored anchor, so all instances replay one session.
  await kvPutNew(key, { sessionStartedAt: anchor });
  const stored = await pgReadAnchor(key);
  if (stored === null) throw new Error("anchor write not visible");
  return stored;
}

async function pgAppendAction(ev: ReprovisionEvent, prefix = ACTIONS_PREFIX): Promise<string | null> {
  const key = `${prefix}${ev.at}-${ev.id}-${randomUUID()}.json`;
  try {
    return (await kvPutNew(key, ev)) ? key : null;
  } catch (err) {
    console.error(`[persistence] instance=${INSTANCE_ID} append failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function pgMerge(prefix: string, into: Map<string, ReprovisionEvent>): Promise<number> {
  let added = 0;
  for (const r of await kvList(prefix)) {
    if (into.has(r.key)) continue;
    if (validAction(r.body)) {
      into.set(r.key, r.body);
      added++;
    }
  }
  return added;
}

async function pgRefresh(): Promise<number | null> {
  const anchor = mem?.anchor ?? (await pgReadAnchor());
  const actions = mem?.actions ?? new Map<string, ReprovisionEvent>();
  const added = await pgMerge(ACTIONS_PREFIX, actions);
  if (anchor !== null) {
    mem = { anchor, actions };
    lastRefreshAt = Date.now();
  }
  slog(`source=postgres actions=${actions.size} (+${added})`);
  return anchor;
}

// ---------- File backend (local dev / tests) ----------

function fileReadAnchor(filename = ANCHOR_FILE): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (Number.isFinite(raw.sessionStartedAt)) return raw.sessionStartedAt;
    throw new Error("invalid session anchor");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function fileRefresh(): number | null {
  const anchor = mem?.anchor ?? fileReadAnchor();
  const actions = mem?.actions ?? new Map<string, ReprovisionEvent>();
  let added = 0;
  try {
    for (const f of fs.readdirSync(ACTIONS_DIR)) {
      if (actions.has(f) || !f.endsWith(".json")) continue;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(ACTIONS_DIR, f), "utf8"));
        if (validAction(v)) {
          actions.set(f, v);
          added++;
        }
      } catch {
        // A partially written file is skipped; the next refresh retries it.
      }
    }
  } catch {
    // No actions directory yet: no actions.
  }
  if (anchor !== null) {
    mem = { anchor, actions };
    lastRefreshAt = Date.now();
  }
  slog(`source=file actions=${actions.size} (+${added})`);
  return anchor;
}

function fileWriteAnchor(anchor: number): number {
  fs.mkdirSync(ACTIONS_DIR, { recursive: true });
  const existing = fileReadAnchor();
  if (existing !== null) return existing;
  const pending = path.join(DATA_DIR, `anchor-${randomUUID()}.tmp`);
  fs.writeFileSync(pending, JSON.stringify({ sessionStartedAt: anchor }), { flag: "wx" });
  try {
    fs.linkSync(pending, ANCHOR_FILE);
    return anchor;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const adopted = fileReadAnchor();
      if (adopted !== null) return adopted;
    }
    throw err;
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

function fileAppendAction(ev: ReprovisionEvent, dir = ACTIONS_DIR): string | null {
  const key = `${ev.at}-${ev.id}-${randomUUID()}.json`;
  const pending = path.join(dir, `${key}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pending, JSON.stringify(ev), { flag: "wx" });
    fs.renameSync(pending, path.join(dir, key));
    return key;
  } catch (err) {
    try { fs.rmSync(pending, { force: true }); } catch { /* preserve the original failure */ }
    console.error(`[persistence] instance=${INSTANCE_ID} append failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------- Public API ----------

// Returns the merged state, or null when the store has never been anchored
// (first boot). Throws PersistUnavailable when the store cannot be read and
// this process has nothing cached - callers must fail the request rather
// than silently reset to the seed.
export async function loadPersisted(): Promise<Persisted | null> {
  if (mem && Date.now() - lastRefreshAt < REFRESH_TTL_MS) {
    return toPersisted(mem);
  }
  try {
    const anchor = usePg() ? await pgRefresh() : useBlob() ? await blobRefresh() : fileRefresh();
    if (anchor === null) return null; // first boot, store reachable
    return toPersisted(mem!);
  } catch (err) {
    if (mem) {
      // Store temporarily unreachable: serve what we have (stale, not reset).
      console.error(`[persistence] instance=${INSTANCE_ID} refresh failed, serving memory:`, err instanceof Error ? err.message : err);
      return toPersisted(mem);
    }
    throw new PersistUnavailable(err instanceof Error ? err.message : String(err));
  }
}

// First boot: anchor the session. Returns the anchor actually in use, which
// may be a concurrently booted instance's anchor.
export async function saveAnchor(anchor: number): Promise<number> {
  const adopted = usePg() ? await pgWriteAnchor(anchor) : useBlob() ? await blobWriteAnchor(anchor) : fileWriteAnchor(anchor);
  mem = { anchor: adopted, actions: mem?.actions ?? new Map() };
  lastRefreshAt = Date.now();
  slog(`anchor=${adopted}`);
  return adopted;
}

// Append one reprovision action. False means the action was NOT saved;
// callers must fail the request visibly instead of reporting a saved change.
// A successful append updates this instance's cache immediately, so the
// same instance always reads its own write within the refresh window.
export async function appendAction(ev: ReprovisionEvent): Promise<boolean> {
  const key = usePg() ? await pgAppendAction(ev) : useBlob() ? await blobAppendAction(ev) : fileAppendAction(ev);
  if (key === null) return false;
  mem?.actions.set(key, ev);
  slog(`appended actions=${mem?.actions.size ?? 1}`);
  return true;
}

// ---------- Isolated demo sessions ----------

// Per-instance cache for isolated demo sessions, under the same TTL and
// merge-by-key rules as the shared session cache. Before this cache existed,
// EVERY poll of a demo session listed the anchor and the actions prefix -
// two advanced operations per poll. Entries are tiny; evicted FIFO.
// refreshedAt uses the real clock (like lastRefreshAt above); the caller's
// `now` is simulation time and drives only the expiry check.
interface DemoMem {
  anchor: number;
  actions: Map<string, ReprovisionEvent>; // key: storage key, as in Mem
  refreshedAt: number; // Date.now()
}
const demoMem = new Map<string, DemoMem>();
const MAX_CACHED_DEMOS = 64;

function demoCacheSet(id: string, entry: DemoMem) {
  demoMem.delete(id);
  demoMem.set(id, entry);
  while (demoMem.size > MAX_CACHED_DEMOS) {
    const oldest = demoMem.keys().next().value;
    if (oldest === undefined) break;
    demoMem.delete(oldest);
  }
}

function demoPaths(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new DemoSessionError("demo_not_found");
  }
  return { dir: path.join(DATA_DIR, "demos", id), prefix: `cloudlabs-ops/demos/${id}/` };
}

export async function createDemoSession(now = Date.now()) {
  const id = randomUUID();
  const { dir, prefix } = demoPaths(id);
  if (usePg()) await pgWriteAnchor(now, `${prefix}anchor.json`);
  else if (useBlob()) await blobWriteAnchor(now, `${prefix}anchor.json`);
  else {
    fs.mkdirSync(path.join(dir, "actions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "anchor.json"), JSON.stringify({ sessionStartedAt: now }), { flag: "wx" });
  }
  // The creating instance already knows the full state; it needs no store
  // round-trip for this demo until the refresh window passes.
  demoCacheSet(id, { anchor: now, actions: new Map(), refreshedAt: Date.now() });
  return { id, expiresAt: now + DEMO_LIFETIME_MS };
}

export async function loadDemoSession(id: string, now: number): Promise<Persisted> {
  const { dir, prefix } = demoPaths(id);
  const isBlob = useBlob();
  const isPg = usePg();
  const cached = demoMem.get(id);
  const finish = (anchor: number, actions: Map<string, ReprovisionEvent>): Persisted => {
    if (now >= anchor + DEMO_LIFETIME_MS) throw new DemoSessionError("demo_expired");
    return { sessionStartedAt: anchor, reprovisionLog: [...actions.values()].sort((a, b) => a.at - b.at) };
  };
  // Within the refresh window this instance's cache answers: zero store
  // operations. Same-instance writes are already in the cache (appendDemoAction).
  if (cached && Date.now() - cached.refreshedAt < REFRESH_TTL_MS) {
    return finish(cached.anchor, cached.actions);
  }
  try {
    const anchor = isPg ? await pgReadAnchor(`${prefix}anchor.json`) : isBlob ? await blobReadAnchor(`${prefix}anchor.json`) : fileReadAnchor(path.join(dir, "anchor.json"));
    if (anchor === null) throw new DemoSessionError("demo_not_found");
    if (isPg) {
      const actions = cached?.actions ?? new Map<string, ReprovisionEvent>();
      await pgMerge(`${prefix}actions/`, actions);
      demoCacheSet(id, { anchor, actions, refreshedAt: Date.now() });
      return finish(anchor, actions);
    }
    if (isBlob) {
      // Merge by key: only actions written by OTHER instances are fetched;
      // keys already in the cache are never re-downloaded.
      const actions = cached?.actions ?? new Map<string, ReprovisionEvent>();
      for (const e of await blobListActions(`${prefix}actions/`)) {
        if (actions.has(e.pathname)) continue;
        const v = await blobFetchJson(e.downloadUrl);
        if (validAction(v)) actions.set(e.pathname, v);
      }
      demoCacheSet(id, { anchor, actions, refreshedAt: Date.now() });
      return finish(anchor, actions);
    }
    const actionDir = path.join(dir, "actions");
    const raw = fs.readdirSync(actionDir).filter((file) => file.endsWith(".json"))
      .map((file) => [file, JSON.parse(fs.readFileSync(path.join(actionDir, file), "utf8")) as unknown] as const);
    const actions = new Map<string, ReprovisionEvent>();
    for (const [file, v] of raw) if (validAction(v)) actions.set(file, v);
    demoCacheSet(id, { anchor, actions, refreshedAt: Date.now() });
    return finish(anchor, actions);
  } catch (err) {
    if (err instanceof DemoSessionError) throw err;
    // Same degradation rule as the shared session: a warm cache serves
    // stale state instead of failing; a cold instance fails visibly.
    if (cached) {
      console.error(`[persistence] instance=${INSTANCE_ID} demo refresh failed, serving memory:`, err instanceof Error ? err.message : err);
      return finish(cached.anchor, cached.actions);
    }
    throw new PersistUnavailable("isolated session storage unavailable");
  }
}

export async function appendDemoAction(id: string, ev: ReprovisionEvent): Promise<boolean> {
  const { dir, prefix } = demoPaths(id);
  const key = usePg() ? await pgAppendAction(ev, `${prefix}actions/`) : useBlob() ? await blobAppendAction(ev, `${prefix}actions/`) : fileAppendAction(ev, path.join(dir, "actions"));
  if (key === null) return false;
  // Same-instance read-after-write: the next cached load includes this action.
  const c = demoMem.get(id);
  if (c) c.actions.set(key, ev);
  slog(`appended demo=${id.slice(0, 8)} actions=${c?.actions.size ?? 1}`);
  return true;
}

// Test hook: drop the in-memory copies so the next load re-reads the backend.
export function resetPersistenceCache() {
  mem = null;
  lastRefreshAt = 0;
  demoMem.clear();
      }
