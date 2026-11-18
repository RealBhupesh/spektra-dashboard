import { Environment, SessionSummary } from "./types";
import { seedEnvironments } from "./seed";
import { computeState, ReprovisionEvent, SESSION_NAME, SEED } from "./replay";
import { loadPersisted, savePersisted } from "./persistence";
import { progressPct, spendUsd, isStuck } from "./filters";

// State model: the seeded cohort plus every subsequent transition is a pure
// function of (SEED, sessionStartedAt, reprovisionLog, now) - see
// lib/replay.ts. Nothing about the simulation needs a database; only the
// session anchor and the operator's reprovision actions are persisted
// (lib/persistence.ts). Two consequences the brief cares about:
//   - billing keeps accruing with wall-clock time while nobody polls, and
//     cold starts / server restarts reconstruct the identical timeline;
//   - every endpoint computes from the same inputs at the same `now`, so
//     summary and rows can never disagree with each other.

interface Live {
  sessionStartedAt: number;
  log: ReprovisionEvent[];
}

async function live(): Promise<Live> {
  const persisted = await loadPersisted();
  if (persisted) {
    return { sessionStartedAt: persisted.sessionStartedAt, log: persisted.reprovisionLog };
  }
  // First boot on this backend: anchor the session. On Vercel the deploy sets
  // SESSION_STARTED_AT explicitly so concurrent cold starts cannot anchor
  // divergent sessions before the first write lands.
  const envAnchor = Number(process.env.SESSION_STARTED_AT);
  const sessionStartedAt = Number.isFinite(envAnchor) && envAnchor > 0 ? envAnchor : Date.now();
  const log: ReprovisionEvent[] = [];
  await savePersisted({ sessionStartedAt, reprovisionLog: log });
  return { sessionStartedAt, log };
}

export async function getEnvironments(now = Date.now()): Promise<Environment[]> {
  const { sessionStartedAt, log } = await live();
  const seeded = seedEnvironments(SEED, sessionStartedAt);
  return computeState(seeded, sessionStartedAt, log, now);
}

export async function reprovision(id: string, now = Date.now()): Promise<Environment | null> {
  const { sessionStartedAt, log } = await live();
  const seeded = seedEnvironments(SEED, sessionStartedAt);
  const envs = computeState(seeded, sessionStartedAt, log, now);
  const e = envs.find((x) => x.id === id);
  if (!e) return null;
  if (e.state !== "failed") return e; // no-op unless failed; reflected as-is
  const nextLog = [...log, { id, at: now }];
  await savePersisted({ sessionStartedAt, reprovisionLog: nextLog });
  return computeState(seeded, sessionStartedAt, nextLog, now).find((x) => x.id === id)!;
}

export async function getSummary(now = Date.now()): Promise<SessionSummary> {
  const envs = await getEnvironments(now);
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
  for (const e of envs) {
    byState[e.state] += 1;
    spend += spendUsd(e);
    completion += progressPct(e);
    if (isStuck(e, now)) stuck += 1;
  }
  const { sessionStartedAt } = await live();
  return {
    sessionName: SESSION_NAME,
    sessionStartedAt,
    now,
    total: envs.length,
    active: envs.length - byState.deprovisioned,
    failures: byState.failed,
    avgCompletionPct: Math.round(completion / envs.length),
    estimatedSpend: Math.round(spend * 100) / 100,
    byState,
    stuckCount: stuck,
  };
}
