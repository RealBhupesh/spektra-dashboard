import { Environment, EnvState, FilterQuery, STUCK_MINUTES } from "./types";

export function spendUsd(e: Environment): number {
  return (e.runtimeMinutes / 60) * e.ratePerHour;
}

// Completed steps, not the step being worked on: a learner who just entered
// step 12 has finished 11 of 12 (92%), not 100%. A learner who fails during
// step 12 keeps 92% instead of reading as finished.
export function completedSteps(e: Environment): number {
  if (e.state === "deprovisioned") return e.totalSteps;
  if (e.state === "in_use" || e.state === "failed") return Math.max(0, e.step - 1);
  return 0;
}

export function progressPct(e: Environment): number {
  return Math.round((completedSteps(e) / e.totalSteps) * 100);
}

export function onStepMinutes(e: Environment, now: number): number {
  if (e.state !== "in_use" && e.state !== "failed") return 0;
  return Math.max(0, (now - e.stepStartedAt) / 60_000);
}

export function isStuck(e: Environment, now: number): boolean {
  return e.state === "in_use" && onStepMinutes(e, now) >= STUCK_MINUTES;
}

function riskRank(e: Environment, now: number): number {
  if (e.state === "failed") return 0;
  if (isStuck(e, now)) return 1;
  if (e.state === "provisioning") return 2;
  if (e.state === "in_use") return 3;
  if (e.state === "ready") return 4;
  return 5; // deprovisioned
}

// Single shared pipeline: manual UI controls and the NL filter compile to the
// same FilterQuery and run through this function server-side.
export function applyFilter(envs: Environment[], fq: FilterQuery, now: number): Environment[] {
  let out = envs.filter((e) => {
    if (fq.states && fq.states.length > 0 && !fq.states.includes(e.state)) return false;
    if (fq.q) {
      const q = fq.q.toLowerCase();
      if (!e.learnerName.toLowerCase().includes(q) && !e.learnerEmail.toLowerCase().includes(q) && !e.id.includes(q)) return false;
    }
    if (typeof fq.step === "number" && e.step !== fq.step) return false;
    if (typeof fq.minStepMinutes === "number") {
      const v = onStepMinutes(e, now);
      if (fq.minStepMinutesExclusive ? v <= fq.minStepMinutes : v < fq.minStepMinutes) return false;
    }
    if (fq.stuck && !isStuck(e, now)) return false;
    if (typeof fq.minProgressPct === "number") {
      const v = progressPct(e);
      if (fq.minProgressExclusive ? v <= fq.minProgressPct : v < fq.minProgressPct) return false;
    }
    if (typeof fq.maxProgressPct === "number") {
      const v = progressPct(e);
      if (fq.maxProgressExclusive ? v >= fq.maxProgressPct : v > fq.maxProgressPct) return false;
    }
    if (typeof fq.minSpend === "number") {
      const v = spendUsd(e);
      if (fq.minSpendExclusive ? v <= fq.minSpend : v < fq.minSpend) return false;
    }
    return true;
  });

  const sort = fq.sort ?? "risk";
  const dir = fq.order === "desc" ? -1 : 1;
  const val = (e: Environment): number | string => {
    switch (sort) {
      case "name": return e.learnerName.toLowerCase();
      case "progress": return progressPct(e);
      case "spend": return spendUsd(e);
      case "stepMinutes": return onStepMinutes(e, now);
      case "risk":
      default: return riskRank(e, now);
    }
  };
  out = out.slice().sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    let c: number;
    if (typeof va === "string" && typeof vb === "string") c = va.localeCompare(vb);
    else c = (va as number) - (vb as number);
    if (c === 0 && sort === "risk") c = onStepMinutes(b, now) - onStepMinutes(a, now); // longest-waiting first within a rank
    if (c === 0) c = a.id.localeCompare(b.id);
    return c * dir;
  });
  return out;
}
