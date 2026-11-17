import { Environment, EnvState, TOTAL_LEARNERS, TOTAL_STEPS } from "./types";
import { mulberry32 } from "./prng";

const FIRST = [
  "Aarav","Ananya","Arjun","Diya","Ishaan","Kavya","Krishna","Meera","Nikhil","Priya",
  "Rahul","Riya","Rohan","Sara","Aditi","Vikram","Neha","Kabir","Tanvi","Aryan",
  "Pooja","Sameer","Naina","Dev","Ira","Yash","Anika","Farhan","Zoya","Om",
  "Liam","Emma","Noah","Olivia","Mason","Ava","Lucas","Mia","Ethan","Sofia",
];
const LAST = [
  "Sharma","Patel","Iyer","Reddy","Khan","Gupta","Nair","Mehta","Das","Kulkarni",
  "Singh","Joshi","Chopra","Bose","Rao","Verma","Ali","Pillai","Saxena","Bhatt",
  "Smith","Garcia","Lee","Kim","Brown","Davis","Miller","Wilson","Moore","Clark",
];
const FAILURE_REASONS = [
  "VM quota exceeded",
  "Image pull timeout",
  "Agent heartbeat lost",
  "Disk provisioning error",
  "Network policy conflict",
];
export const LAB_STEPS = [
  "Sign in to the Azure portal",
  "Create a resource group",
  "Deploy a virtual network",
  "Provision a Linux VM",
  "Configure NSG rules",
  "Attach a managed disk",
  "Install the monitoring agent",
  "Set up a storage account",
  "Configure blob access tiers",
  "Create an alert rule",
  "Review cost analysis",
  "Clean up resources",
];

export function seedEnvironments(seed = 20261117, now = Date.now()): Environment[] {
  const rand = mulberry32(seed);
  const envs: Environment[] = [];

  // Target distribution across 120 seats
  const plan: [EnvState, number][] = [
    ["provisioning", 8],
    ["ready", 18],
    ["in_use", 72],
    ["failed", 12],
    ["deprovisioned", 10],
  ];

  let i = 0;
  for (const [state, count] of plan) {
    for (let k = 0; k < count; k++) {
      i++;
      const first = FIRST[Math.floor(rand() * FIRST.length)];
      const last = LAST[Math.floor(rand() * LAST.length)];
      const ratePerHour = 1.6 + rand() * 1.8; // $1.60 - $3.40 per lab-hour
      const startedAgoMin = 15 + rand() * 95; // session has been running a while

      let step = 0;
      let stepStartedAt = now;
      let failureReason: string | null = null;
      let runtimeMinutes = startedAgoMin;
      let env_stepDurationMin: number | undefined;

      if (state === "in_use") {
        step = 1 + Math.floor(rand() * TOTAL_STEPS);
        const stuckCohort = rand() < 0.22; // ~22% look stuck on first load
        const onStepMin = stuckCohort ? 20 + rand() * 45 : 1 + rand() * 14;
        stepStartedAt = Math.round(now - onStepMin * 60_000);
        // Stuck learners keep a long expected step duration so they stay
        // stuck for a while instead of resolving on the first drift tick;
        // they eventually recover (15-45 min later) so the screen moves.
        env_stepDurationMin = stuckCohort ? onStepMin + 15 + rand() * 30 : 3 + rand() * 5;
      } else if (state === "failed") {
        step = 1 + Math.floor(rand() * TOTAL_STEPS);
        const onStepMin = 4 + rand() * 50;
        stepStartedAt = Math.round(now - onStepMin * 60_000);
        failureReason = FAILURE_REASONS[Math.floor(rand() * FAILURE_REASONS.length)];
      } else if (state === "deprovisioned") {
        step = TOTAL_STEPS;
        runtimeMinutes = 60 + rand() * 50; // finished, billing stopped
      } else if (state === "provisioning") {
        step = 0;
        runtimeMinutes = 1 + rand() * 4;
        stepStartedAt = Math.round(now - runtimeMinutes * 60_000);
      } else {
        // ready
        step = 0;
        stepStartedAt = Math.round(now - (3 + rand() * 25) * 60_000);
      }

      envs.push({
        id: `env-${String(i).padStart(3, "0")}`,
        learnerName: `${first} ${last}`,
        learnerEmail: `${first.toLowerCase()}.${last.toLowerCase()}${i}@workshop.example.com`,
        state,
        step,
        totalSteps: TOTAL_STEPS,
        stepStartedAt,
        startedAt: Math.round(now - startedAgoMin * 60_000),
        runtimeMinutes,
        ratePerHour: Math.round(ratePerHour * 100) / 100,
        failureReason,
        stepDurationMin: env_stepDurationMin,
      });
    }
  }
  // Shuffle so risk order is not already applied
  for (let j = envs.length - 1; j > 0; j--) {
    const m = Math.floor(rand() * (j + 1));
    [envs[j], envs[m]] = [envs[m], envs[j]];
  }
  if (envs.length !== TOTAL_LEARNERS) throw new Error("seed count mismatch");
  return envs;
}
