import fs from "node:fs";
import path from "node:path";
import { Environment, SessionSummary, TOTAL_STEPS } from "./types";
import { seedEnvironments } from "./seed";
import { progressPct, spendUsd, isStuck } from "./filters";

const DATA_DIR = path.join(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SESSION_NAME = "AZ-104 Administrator Workshop, Nov cohort";
const SEED = 20261117;

interface Persisted {
  sessionStartedAt: number;
  envs: Environment[];
  reprovisionLog: { id: string; at: number }[];
  lastTickAt: number;
}

interface Store extends Persisted {
  lastTickAt: number;
  lastPersistAt: number;
}

// Hold the store on globalThis so Next.js module reloading / route isolation
// cannot split state between endpoints in a single server process.
const g = globalThis as unknown as { __cloudlabsStore?: Store };

function load(): Store {
  if (g.__cloudlabsStore) return g.__cloudlabsStore;
  let persisted: Persisted | null = null;
  try {
    persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Persisted;
  } catch {
    persisted = null;
  }
  const now = Date.now();
  const store: Store = persisted
    ? { ...persisted, lastPersistAt: 0 }
    : {
        sessionStartedAt: now,
        envs: seedEnvironments(SEED, now),
        reprovisionLog: [],
        lastTickAt: now,
        lastPersistAt: 0,
      };
  g.__cloudlabsStore = store;
  return store;
}

function persist(store: Store, force = false) {
  const now = Date.now();
  if (!force && now - store.lastPersistAt < 2000) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const snapshot: Persisted = {
      sessionStartedAt: store.sessionStartedAt,
      envs: store.envs,
      reprovisionLog: store.reprovisionLog,
      lastTickAt: store.lastTickAt,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot));
    store.lastPersistAt = now;
  } catch {
    // Persistence is best-effort; the in-memory store stays authoritative.
  }
}

// Server-side state drift: billing accrues with wall-clock time and
// environments transition on their own, so polling actually moves the screen.
export function tick(): Store {
  const store = load();
  const now = Date.now();
  // Bill the full elapsed wall-clock time, however long the gap: lab VMs
  // keep costing money while nobody polls the dashboard, including across
  // server restarts (lastTickAt is persisted).
  const dtSec = Math.max(0, (now - store.lastTickAt) / 1000);
  if (dtSec <= 0) return store;
  store.lastTickAt = now;

  for (const e of store.envs) {
    // Billing: everything not deprovisioned keeps accruing runtime, including
    // failed environments (a broken VM is still provisioned).
    if (e.state !== "deprovisioned") {
      e.runtimeMinutes += dtSec / 60;
    }
    switch (e.state) {
      case "provisioning": {
        const p = 1 - Math.exp(-dtSec / 25); // mean ~25s to provision
        if (Math.random() < p) {
          if (Math.random() < 0.08) {
            e.state = "failed";
            e.failureReason = "Agent heartbeat lost";
            e.stepStartedAt = now;
          } else {
            e.state = "ready";
            e.stepStartedAt = now;
          }
        }
        break;
      }
      case "ready": {
        const p = 1 - Math.exp(-dtSec / 45); // learner signs in and starts
        if (Math.random() < p) {
          e.state = "in_use";
          e.step = 1;
          e.stepStartedAt = now;
          e.stepDurationMin = 3 + Math.random() * 5;
        }
        break;
      }
      case "in_use": {
        const onStepMin = (now - e.stepStartedAt) / 60_000;
        // Per-learner expected step duration (set at seed / on advance);
        // small failure chance on each step completion.
        const stepMeanMin = e.stepDurationMin ?? 4 + (e.step % 6);
        if (onStepMin >= stepMeanMin) {
          if (Math.random() < 0.02) {
            e.state = "failed";
            e.failureReason = "Network policy conflict";
            e.stepStartedAt = now;
          } else if (e.step >= TOTAL_STEPS) {
            e.state = "deprovisioned";
          } else {
            e.step += 1;
            e.stepStartedAt = now;
            // Most steps are quick, but some learners stall again: without
            // an occasional long step here, stuck could only ever come from
            // the seed cohort and the signal went dark after ~2 hours.
            e.stepDurationMin = Math.random() < 0.08 ? 22 + Math.random() * 20 : 3 + Math.random() * 5;
          }
        }
        break;
      }
      default:
        break; // failed and deprovisioned are stable until acted on
    }
  }
  persist(store);
  return store;
}

export function getEnvironments(): Environment[] {
  return tick().envs;
}

export function reprovision(id: string): Environment | null {
  const store = tick();
  const e = store.envs.find((x) => x.id === id);
  if (!e) return null;
  if (e.state !== "failed") return e; // no-op unless failed; reflected as-is
  e.state = "provisioning";
  e.failureReason = null;
  e.step = 0;
  e.stepStartedAt = Date.now();
  store.reprovisionLog.push({ id, at: Date.now() });
  persist(store, true);
  return e;
}

export function getSummary(): SessionSummary {
  const store = tick();
  const now = Date.now();
  const byState: SessionSummary["byState"] = {
    provisioning: 0,
    ready: 0,
    in_use: 0,
    failed: 0,
    deprovisioned: 0,
  };
  let spend = 0;
  let completion = 0;
  let stuck = 0;
  for (const e of store.envs) {
    byState[e.state] += 1;
    spend += spendUsd(e);
    completion += progressPct(e);
    if (isStuck(e, now)) stuck += 1;
  }
  return {
    sessionName: SESSION_NAME,
    sessionStartedAt: store.sessionStartedAt,
    now,
    total: store.envs.length,
    active: store.envs.length - byState.deprovisioned,
    failures: byState.failed,
    avgCompletionPct: Math.round(completion / store.envs.length),
    estimatedSpend: Math.round(spend * 100) / 100,
    byState,
    stuckCount: stuck,
  };
}
