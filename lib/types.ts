export type EnvState =
  | "provisioning"
  | "ready"
  | "in_use"
  | "failed"
  | "deprovisioned";

export const STATE_ORDER: EnvState[] = [
  "provisioning",
  "ready",
  "in_use",
  "failed",
  "deprovisioned",
];

export interface Environment {
  id: string; // env-001 ... env-120
  learnerName: string;
  learnerEmail: string;
  state: EnvState;
  step: number; // 0 = not started lab guide, 1..totalSteps
  totalSteps: number;
  stepStartedAt: number; // epoch ms, meaningful for in_use / failed
  startedAt: number; // when the environment was first requested
  runtimeMinutes: number; // accrued billed minutes
  ratePerHour: number; // USD per hour for this lab SKU
  failureReason: string | null;
  // Internal: how long the current step is expected to take this learner.
  // Stuck learners simply have a long expected duration, so drift does not
  // instantly resolve them on the first tick.
  stepDurationMin?: number;
}

export interface FilterQuery {
  states?: EnvState[];
  q?: string;
  step?: number;
  minStepMinutes?: number;
  minProgressPct?: number;
  maxProgressPct?: number;
  minSpend?: number;
  // Strict vs inclusive thresholds, preserved from the instructor's words:
  // "under 25%" excludes a learner at exactly 25%, "25% or less" includes her.
  minStepMinutesExclusive?: boolean;
  minProgressExclusive?: boolean;
  maxProgressExclusive?: boolean;
  minSpendExclusive?: boolean;
  stuck?: boolean;
  sort?: "risk" | "name" | "progress" | "spend" | "stepMinutes";
  order?: "asc" | "desc";
}

export interface SessionSummary {
  sessionName: string;
  sessionStartedAt: number;
  now: number;
  total: number;
  active: number; // not deprovisioned
  failures: number;
  avgCompletionPct: number;
  estimatedSpend: number; // USD
  byState: Record<EnvState, number>;
  stuckCount: number;
}

export const TOTAL_LEARNERS = 120;
export const TOTAL_STEPS = 12;
export const STUCK_MINUTES = 20;
