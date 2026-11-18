import { Environment, TOTAL_STEPS } from "./types";
import { mulberry32 } from "./prng";

// One operator action: the only external, non-derivable input to the
// simulation. Everything else is a pure function of (seed, clock, this log).
export interface ReprovisionEvent {
  id: string;
  at: number;
}

export const SEED = 20261117;
export const SESSION_NAME = "AZ-104 Administrator Workshop, Nov cohort";

// FNV-1a: stable string hash for per-environment transition streams.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Each environment draws its post-seed transitions from its own stream, keyed
// by environment id and life epoch (how many reprovisions it has had). Replay
// order across environments is therefore irrelevant and every server instance
// - cold start or warm - reconstructs the identical timeline.
function envRand(envId: string, epoch: number) {
  return mulberry32((SEED ^ hashStr(envId) ^ Math.imul(epoch + 1, 0x9e3779b9)) >>> 0);
}

function exp(rand: () => number, meanMs: number): number {
  return -Math.log(1 - rand()) * meanMs;
}

function drawStepMinutes(rand: () => number): number {
  // Most steps are quick, but some learners stall again: without an
  // occasional long step, stuck could only ever come from the seed cohort
  // and the signal went dark after ~2 hours.
  return rand() < 0.08 ? 22 + rand() * 20 : 3 + rand() * 5;
}

// Advance one environment through every transition scheduled in (from, to],
// accruing billable runtime segment by segment so billing stops at the exact
// simulated deprovision time, however long the gap since anyone looked.
function advance(e: Environment, from: number, to: number, rand: () => number) {
  let t = from;
  // A seeded in_use step already had its expected duration drawn at seed time;
  // resume it instead of redrawing so the seeded stuck cohort keeps its clock.
  // Clamped to the segment start so the seeded state snapshot holds exactly
  // at the session anchor.
  let dueAt: number | null =
    e.state === "in_use" && typeof e.stepDurationMin === "number"
      ? Math.max(t, e.stepStartedAt + e.stepDurationMin * 60_000)
      : null;

  const bill = (a: number, b: number) => {
    if (e.state !== "deprovisioned" && b > a) e.runtimeMinutes += (b - a) / 60_000;
  };

  while (true) {
    if (dueAt === null) {
      switch (e.state) {
        // Scheduled from the segment start (never the seeded stepStartedAt):
        // seeded provisioning/ready ages describe the past, and drawing from
        // them would let transitions land before the session anchor.
        case "provisioning":
          dueAt = t + exp(rand, 40_000); // mean ~40s to provision
          break;
        case "ready":
          dueAt = t + exp(rand, 8 * 60_000); // mean ~8min to sign in
          break;
        case "in_use": {
          const d = drawStepMinutes(rand);
          e.stepDurationMin = d;
          dueAt = t + d * 60_000;
          break;
        }
        default:
          bill(t, to); // failed and deprovisioned are stable until acted on
          return;
      }
    }
    if (dueAt > to) {
      bill(t, to);
      return;
    }
    bill(t, dueAt);
    t = dueAt;
    dueAt = null;
    switch (e.state) {
      case "provisioning":
        if (rand() < 0.08) {
          e.state = "failed";
          e.failureReason = "Agent heartbeat lost";
        } else {
          e.state = "ready";
        }
        e.stepStartedAt = t;
        break;
      case "ready":
        e.state = "in_use";
        e.step = 1;
        e.stepStartedAt = t;
        break;
      case "in_use":
        if (rand() < 0.02) {
          e.state = "failed";
          e.failureReason = "Network policy conflict";
          e.stepStartedAt = t;
        } else if (e.step >= TOTAL_STEPS) {
          e.state = "deprovisioned";
          e.stepStartedAt = t;
        } else {
          e.step += 1;
          e.stepStartedAt = t;
        }
        break;
      default:
        break;
    }
  }
}

// Reconstruct the full environment list at `now` from the seed and the
// reprovision log alone. Pure: same inputs give byte-identical output on any
// instance, which is what lets the demo run on stateless serverless
// infrastructure with no shared database.
export function computeState(
  seeded: Environment[],
  sessionStartedAt: number,
  log: ReprovisionEvent[],
  now: number,
): Environment[] {
  const byId = new Map<string, ReprovisionEvent[]>();
  for (const ev of log) {
    const list = byId.get(ev.id) ?? [];
    list.push(ev);
    byId.set(ev.id, list);
  }
  return seeded.map((seedEnv) => {
    const e: Environment = { ...seedEnv };
    const events = (byId.get(e.id) ?? []).slice().sort((a, b) => a.at - b.at);
    let epoch = 0;
    let cursor = sessionStartedAt;
    for (const ev of events) {
      if (ev.at < cursor) continue; // out-of-order guard; log is append-only
      advance(e, cursor, ev.at, envRand(e.id, epoch));
      // The action is a no-op unless the environment is failed at that moment
      // (mirrors the server-side check); a valid action starts a new life.
      if (e.state === "failed") {
        e.state = "provisioning";
        e.failureReason = null;
        e.step = 0;
        e.stepStartedAt = ev.at;
        epoch++;
      }
      cursor = ev.at;
    }
    advance(e, cursor, now, envRand(e.id, epoch));
    return e;
  });
}
