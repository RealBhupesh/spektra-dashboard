import { Environment, SessionSummary } from "./types";
import { seedEnvironments } from "./seed";
import { computeState, ReprovisionEvent, SESSION_NAME, SEED } from "./replay";
import { appendAction, appendDemoAction, DEMO_LIFETIME_MS, loadDemoSession, loadDemoSessionFresh, loadPersisted, loadPersistedFresh, saveAnchor } from "./persistence";
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
  // Evaluate at the log's newest event, not only at this request's `now`: a
  // concurrent instance's event can be stamped later than our `now`, and
  // treating it as still-in-the-future would both misreport the state and
  // reopen the double-restart race the epoch key closes.
  const evalAt = Math.max(now, ...log.map((ev) => ev.at));
  const envs = computeState(seeded, sessionStartedAt, log, evalAt);
  const e = envs.find((x) => x.id === id);
  if (!e) return null;
  if (e.state !== "failed") return { environment: e, stateVersion: log.length, action: null }; // no-op unless failed; reflected as-is
  // The action only counts if it is durably appended to the shared log; a
  // failed write must fail the request, not report an ephemeral change. The
  // append is keyed by the per-target epoch this decision observed - the
  // number of prior restarts of THIS environment in the log - so two
  // concurrent restarts of it conflict in the store instead of
  // double-appending, even when the racers' cached global log lengths
  // differ because of unrelated events for other environments.
  const action = { id, at: now };
  const targetEpoch = log.filter((ev) => ev.id === id).length;
  const outcome = await (demoId === null ? appendAction(action, targetEpoch) : appendDemoAction(demoId, action, targetEpoch));
  if (outcome === "error") throw new Error("persist_failed");
  if (outcome === "conflict") {
    // A concurrent request already restarted this environment from the same
    // observed state and won the key. Reload past the refresh window and
    // report the true resulting state as a no-op, never a second restart.
    const fresh = demoId === null ? await loadPersistedFresh() : await loadDemoSessionFresh(demoId, now);
    // The winner's event can be stamped later than this request's `now`
    // (both clocks moved during the race); evaluate at the log's newest
    // event so the winning restart is not treated as still in the future.
    const evalAt = fresh ? Math.max(now, ...fresh.reprovisionLog.map((ev) => ev.at)) : now;
    const e2 = fresh && computeState(seeded, fresh.sessionStartedAt, fresh.reprovisionLog, evalAt).find((x) => x.id === id);
    if (!e2 || e2.state === "failed") throw new Error("persist_failed"); // winner's write not visible: fail visibly
    return { environment: e2, stateVersion: fresh.reprovisionLog.length, action: null };
  }
  const nextLog = [...log, action];
  return { environment: computeState(seeded, sessionStartedAt, nextLog, evalAt).find((x) => x.id === id)!, stateVersion: nextLog.length, action };
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
