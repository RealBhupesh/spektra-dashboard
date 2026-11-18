import fs from "node:fs";
import path from "node:path";
import { ReprovisionEvent } from "./replay";

// The simulation itself is derivable (lib/replay.ts), so the only state that
// must survive a cold start is the session anchor and the operator's
// reprovision actions. Three backends, chosen by environment:
//   1. Vercel Blob  - on Vercel, when BLOB_READ_WRITE_TOKEN is set (free Hobby
//      tier; the store is created once at deploy time).
//   2. Local file   - .data/state.json for npm start / npm run dev.
//   3. Memory       - last-resort fallback so a storage outage degrades the
//      demo (reprovisions revert on cold start) instead of taking it down.
export interface Persisted {
  sessionStartedAt: number;
  reprovisionLog: ReprovisionEvent[];
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const BLOB_PATH = "cloudlabs-ops/state.json";

let mem: Persisted | null = null;
let cache: { at: number; value: Persisted | null } = { at: 0, value: null };
const CACHE_TTL_MS = 15_000;

function readFileStore(): Persisted | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<Persisted> & {
      // Pre-replay shape stored derived environments; only the anchor and log
      // carry over, the rest is recomputed.
      sessionStartedAt?: number;
      reprovisionLog?: ReprovisionEvent[];
    };
    if (typeof raw.sessionStartedAt !== "number") return null;
    return {
      sessionStartedAt: raw.sessionStartedAt,
      reprovisionLog: Array.isArray(raw.reprovisionLog) ? raw.reprovisionLog : [],
    };
  } catch {
    return null;
  }
}

function writeFileStore(p: Persisted) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(p));
  } catch {
    // Best-effort locally; the in-memory copy stays authoritative.
  }
}

async function readBlobStore(): Promise<Persisted | null> {
  try {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
    const blob = blobs.find((b) => b.pathname === BLOB_PATH);
    if (!blob) return null;
    const res = await fetch(blob.downloadUrl, {
      headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as Persisted;
    if (typeof raw.sessionStartedAt !== "number" || !Array.isArray(raw.reprovisionLog)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeBlobStore(p: Persisted) {
  try {
    const { put } = await import("@vercel/blob");
    await put(BLOB_PATH, JSON.stringify(p), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  } catch {
    // Best-effort: the in-memory copy stays authoritative for this instance.
  }
}

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export async function loadPersisted(): Promise<Persisted | null> {
  if (mem) return mem;
  if (useBlob()) {
    if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    const v = await readBlobStore();
    cache = { at: Date.now(), value: v };
    mem = v ?? mem;
    return v;
  }
  mem = readFileStore();
  return mem;
}

export async function savePersisted(p: Persisted) {
  mem = p;
  if (useBlob()) {
    cache = { at: Date.now(), value: p };
    await writeBlobStore(p);
    return;
  }
  writeFileStore(p);
}

// Test hook: drop the in-memory copy so the next load re-reads the backend.
export function resetPersistenceCache() {
  mem = null;
  cache = { at: 0, value: null };
}
