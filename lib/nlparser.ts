import { EnvState, FilterQuery } from "./types";

// Human-readable summary of a compiled filter, used for both the local
// compiler and for describing LLM output before it is applied.
export function describeFilter(f: FilterQuery): string[] {
  const d: string[] = [];
  if (f.states?.length) d.push(`state is ${f.states.map((s) => s.replace("_", " ")).join(" or ")}`);
  if (f.stuck) d.push("stuck (on the same step 20+ min)");
  if (typeof f.step === "number") d.push(`on step ${f.step}`);
  if (typeof f.minStepMinutes === "number") d.push(`on current step for ${f.minStepMinutes}+ min`);
  if (typeof f.minProgressPct === "number") d.push(`progress at least ${f.minProgressPct}%`);
  if (typeof f.maxProgressPct === "number") d.push(`progress under ${f.maxProgressPct}%`);
  if (typeof f.minSpend === "number") d.push(`spend over $${f.minSpend}`);
  if (f.q) d.push(`name contains "${f.q}"`);
  if (f.sort && f.sort !== "risk" && f.sort !== "name") {
    d.push(`sorted by ${f.sort === "stepMinutes" ? "time on current step" : f.sort}, ${f.order === "desc" ? "highest" : "lowest"} first`);
  }
  return d;
}

export interface NLResult {
  ok: boolean;
  filter: FilterQuery;
  description: string[];
  confidence: number;
  source: "local-parser" | "llm" | "llm-fallback-local";
  degraded: boolean;
  // True when a model produced this filter: the UI must show the plain
  // description and wait for the instructor to confirm before applying it.
  requiresConfirmation?: boolean;
  message?: string;
}

const STATE_WORDS: [RegExp, EnvState][] = [
  [/\bfail(?:ed|ing|ures?)?\b/i, "failed"],
  [/\bin[- ]?use\b|\bactive\b|\bworking\b/i, "in_use"],
  [/\bready\b/i, "ready"],
  [/\bprovisioning\b|\bspinning up\b|\bstarting up\b/i, "provisioning"],
  [/\bdeprovisioned\b/i, "deprovisioned"],
];

// Deterministic local compiler for the phrasings instructors actually type.
// It is the always-available tier: an LLM (when configured) may produce the
// same FilterQuery shape, but the dashboard never depends on the model.
export function compileNL(input: string): NLResult {
  const text = input.trim();
  const filter: FilterQuery = {};
  const description: string[] = [];
  let matched = 0;
  const categories = new Set<string>();

  const states: EnvState[] = [];
  for (const [re, st] of STATE_WORDS) {
    if (re.test(text)) {
      states.push(st);
      matched++;
      categories.add("state");
    }
  }
  if (states.length > 0) {
    filter.states = [...new Set(states)];
    description.push(`state is ${filter.states.join(" or ")}`);
  }

  if (/\bstuck\b|\bblocked\b|\bnot moving\b|\bno progress\b/i.test(text)) {
    filter.stuck = true;
    matched++;
    categories.add("stuck");
    description.push("stuck (on the same step 20+ min)");
  }

  const stepMatch = text.match(/step\s*(\d{1,2})/i);
  if (stepMatch) {
    filter.step = Math.max(0, Math.min(12, parseInt(stepMatch[1], 10)));
    matched++;
    categories.add("step");
    description.push(`on step ${filter.step}`);
  }

  const overMin = text.match(/(?:over|more than|older than|at least|>=?|than)\s*(\d{1,3})\s*(?:min|mins|minutes?)\b/i);
  if (overMin) {
    filter.minStepMinutes = parseInt(overMin[1], 10);
    matched++;
    categories.add("minutes");
    description.push(`on current step for ${filter.minStepMinutes}+ min`);
  }

  const overPct = text.match(/(?:over|more than|above|at least|>=?)\s*(\d{1,3})\s*(?:%|percent)\s*(?:done|complete|completed|of progress)?/i);
  if (overPct) {
    filter.minProgressPct = Math.min(100, parseInt(overPct[1], 10));
    matched++;
    categories.add("progress");
    description.push(`progress at least ${filter.minProgressPct}%`);
  }
  const underPct = text.match(/(?:under|less than|below|<=?)\s*(\d{1,3})\s*(?:%|percent)/i);
  if (underPct) {
    filter.maxProgressPct = Math.min(100, parseInt(underPct[1], 10));
    matched++;
    categories.add("progress");
    description.push(`progress under ${filter.maxProgressPct}%`);
  }

  const spendMatch =
    text.match(/(?:cost(?:ing)?|spent|spend|bill(?:ed)?)\s*(?:over|more than|above|>=?)\s*\$?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(?:over|above|more than|>=?)\s*\$\s*(\d+(?:\.\d+)?)/i);
  if (spendMatch) {
    filter.minSpend = parseFloat(spendMatch[1]);
    matched++;
    categories.add("spend");
    description.push(`spend over $${filter.minSpend}`);
  }

  // Superlative spend questions need no threshold: sort, don't filter.
  const spendTop =
    !spendMatch &&
    /\bmost\s+expensive\b|\b(?:cost|spend|bill)(?:ing|s|ed)?\s+the\s+(?:most|highest)\b|\b(?:highest|biggest|top|largest)\s+(?:spend|spenders?|costs?|bills?)\b|\bspend(?:er|ing)?s?\s+(?:the\s+)?most\b/i.test(
      text,
    );
  if (spendTop) {
    filter.sort = "spend";
    filter.order = "desc";
    matched++;
    categories.add("spend");
    description.push("sorted by spend, highest first");
  }

  const nameMatch = text.match(/(?:named|name is|learner|student)\s+([a-z][a-z .'-]{1,40})/i);
  if (nameMatch && matched === 0) {
    const candidate = nameMatch[1].trim().replace(/^named\s+/i, "");
    // A name is 1-3 words and not a clause; otherwise this is a free-form
    // query that belongs to the model tier, not a bogus name search.
    const words = candidate.split(/\s+/);
    const stop = new Set(["who", "that", "the", "with", "and", "or", "over", "under", "more", "less", "than", "made", "have", "has", "are", "is"]);
    const looksLikeName = words.length <= 3 && !words.some((w) => stop.has(w.toLowerCase()));
    if (looksLikeName) {
      filter.q = candidate;
      matched++;
      categories.add("name");
      description.push(`name contains "${filter.q}"`);
    }
  }

  if (/\s+or\s+/i.test(text) && categories.size > 1) {
    return {
      ok: false,
      filter: {},
      description: [],
      confidence: 0,
      source: "local-parser",
      degraded: false,
      message:
        'I can only combine conditions with AND, not "or". Run them one at a time, e.g. "failed" then "stuck", or try separate searches.',
    };
  }

  if (matched === 0) {
    return {
      ok: false,
      filter: {},
      description: [],
      confidence: 0,
      source: "local-parser",
      degraded: false,
      message:
        'Could not compile that into a filter. Try "failed", "stuck on step 4 over 20 min", "over 50% done", or "costing over $8".',
    };
  }

  if (!filter.sort) filter.sort = "risk";
  return {
    ok: true,
    filter,
    description,
    confidence: 0.9,
    source: "local-parser",
    degraded: false,
  };
}
