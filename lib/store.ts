import { Environment, SessionSummary } from "./types";
import { seedEnvironments } from "./seed";
import { computeState, ReprovisionEvent, SESSION_NAME, SEED } from "./replay";
import { appendAction, appendDemoAction, DEMO_LIFETIME_MS, loadDemoSession, loadPersisted, saveAnchor } from "./persistence";
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

async function live(now: number, demoId: string | null): Promise<Live> {
  const persisted = demoId === null ? await loadPersisted() : await loadDemoSession(demoId, now);
  if (persisted) {
    return { sessionStartedAt: persisted.sessionStartedAt, log: persisted.reprovisionLog };
  }
  // First boot on this backend: anchor the session. On Vercel the deploy sets
  // SESSION_STARTED_AT explicitly so concurrent cold starts cannot anchor
  // divergent sessions; saveAnchor adopts the winner's anchor if they race.
  const envAnchor = Number(process.env.SESSION_STARTED_AT);
  const sessionStartedAt = await saveAnchor(Number.isFinite(envAnchor) && envAnchor > 0 ? envAnchor : now);
  return { sessionStartedAt, log: [] };
}

export async function getSnapshot(now = Date.now(), demoId: string | null = null) {
  const { sessionStartedAt, log } = await live(now, demoId);
  const seeded = seedEnvironments(SEED, sessionStartedAt);
  return {
    now,
    sessionStartedAt,
    sessionExpiresAt: demoId === null ? null : sessionStartedAt + DEMO_LIFETIME_MS,
    // The log is append-only, so its length is a monotone version for this
    // session scope, and the log itself is the inclusion proof: clients
    // discard any snapshot whose actions do not contain an action they
    // already confirmed (a count alone is not set inclusion), instead of
    // visibly rolling back.
    stateVersion: log.length,
    actions: log,
    environments: computeState(seeded, sessionStartedAt, log, now),
  };
}

export async function reprovision(id: string, now = Date.now(), demoId: string | null = null): Promise<{ environment: Environment; stateVersion: number; action: ReprovisionEvent | null } | null> {
  const { sessionStartedAt, log } = await live(now, demoId);
  const seeded = seedEnvironments(SEED, sessionStartedAt);
  const envs = computeState(seeded, sessionStartedAt, log, now);
  const e = envs.find((x) => x.id === id);
  if (!e) return null;
  if (e.state !== "failed") return { environment: e, stateVersion: log.length, action: null }; // no-op unless failed; reflected as-is
  // The action only counts if it is durably appended to the shared log; a
  // failed write must fail the request, not report an ephemeral change.
  const action = { id, at: now };
  const saved = await (demoId === null ? appendAction(action) : appendDemoAction(demoId, action));
  if (!saved) throw new Error("persist_failed");
  const nextLog = [...log, action];
  return { environment: computeState(seeded, sessionStartedAt, nextLog, now).find((x) => x.id === id)!, stateVersion: nextLog.length, action };
}

export function summarizeSnapshot({ now, sessionStartedAt, environments: envs }: Awaited<ReturnType<typeof getSnapshot>>): SessionSummary {
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
  return {
    sessionName: SESSION_NAME,
    sessionStartedAt,
    now,
    total: envs.length,
    active: envs.length - byState.deprovisioned,
    failures: byState.failed,
    avgCompletionPct: envs.length ? Math.round(completion / envs.length) : 0,
    estimatedSpend: Math.round(spend * 100) / 100,
    byState,
    stuckCount: stuck,
  };
}
