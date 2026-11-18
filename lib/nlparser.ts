import { EnvState, FilterQuery } from "./types";

// Human-readable summary of a compiled filter, used for both the local
// compiler and for describing LLM output before it is applied.
export function describeFilter(f: FilterQuery): string[] {
  const d: string[] = [];
  if (f.states?.length) d.push(`state is ${f.states.map((s) => s.replace("_", " ")).join(" or ")}`);
  if (f.stuck) d.push("stuck (on the same step 20+ min)");
  if (typeof f.step === "number") d.push(`on step ${f.step}`);
  if (typeof f.minStepMinutes === "number") {
    d.push(f.minStepMinutesExclusive ? `on current step for more than ${f.minStepMinutes} min` : `on current step for ${f.minStepMinutes}+ min`);
  }
  if (typeof f.minProgressPct === "number") {
    d.push(f.minProgressExclusive ? `progress over ${f.minProgressPct}%` : `progress at least ${f.minProgressPct}%`);
  }
  if (typeof f.maxProgressPct === "number") {
    d.push(f.maxProgressExclusive ? `progress under ${f.maxProgressPct}%` : `progress at most ${f.maxProgressPct}%`);
  }
  if (typeof f.minSpend === "number") {
    d.push(f.minSpendExclusive ? `spend over $${f.minSpend}` : `spend at least $${f.minSpend}`);
  }
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

// Words the compiler understands as sentence structure, not filter content.
const FILLER = new Set(
  `show me all everyone every any the a an of who are is that with and get list give find learners learner students student
   environments environment env envs labs lab people folks please on in for to their them currently right now much many how
   what which whose still been have has had do does did just only there here see want need display sort sorted order by
   step steps min mins minutes minute hour hours percent done complete completed completion progress costing cost costs spend
   spends spent spending bill bills billed expensive most highest biggest top largest over under more less than above below
   least older waiting long slow idle blocked moving stuck failed failing failure failures ready active working provisioning
   spinning starting deprovisioned use named name called or`.split(/\s+/),
);

function abstain(message: string): NLResult {
  return { ok: false, filter: {}, description: [], confidence: 0, source: "local-parser", degraded: false, message };
}

// Deterministic local compiler for the phrasings instructors actually type.
// It is the always-available tier: an LLM (when configured) may produce the
// same FilterQuery shape, but the dashboard never depends on the model.
// Two hard rules keep it honest:
//   - anything it does not understand (negation, unknown words) makes it
//     abstain instead of silently dropping that part of the request;
//   - it never guesses: a partial match reports exactly what it matched.
export function compileNL(input: string): NLResult {
  const text = input.trim();
  const filter: FilterQuery = {};
  let matched = 0;
  const categories = new Set<string>();
  // Working copy; each matched clause's span is blanked out so the final
  // coverage check can spot words no clause claimed.
  let rest = ` ${text} `;
  const claim = (m: RegExpMatchArray) => {
    if (typeof m.index === "number") rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
  };

  // Negation changes meaning ("not failed" is not "failed"), and dropping it
  // silently inverts the instructor's intent. Abstain instead. The stuck
  // idioms "not moving" / "no progress" are whitelisted first.
  const negProbe = text.replace(/not moving|no progress/gi, " ");
  if (/\bnot\b|\bnever\b|\bn't\b|\bexcept\b|\bexcluding\b|\bwithout\b|\bother than\b/i.test(negProbe)) {
    return abstain(
      'I cannot compile negation safely. Say what you want to see instead - e.g. "ready" rather than "not failed" - or use the state buttons.',
    );
  }

  const states: EnvState[] = [];
  for (const [re, st] of STATE_WORDS) {
    const m = rest.match(re);
    if (m) {
      states.push(st);
      matched++;
      categories.add("state");
      claim(m);
    }
  }
  if (states.length > 0) filter.states = [...new Set(states)];

  const stuckM = rest.match(/\bstuck\b|\bblocked\b|\bnot moving\b|\bno progress\b/i);
  if (stuckM) {
    filter.stuck = true;
    matched++;
    categories.add("stuck");
    claim(stuckM);
  }

  const stepMatch = rest.match(/step\s*(\d{1,2})/i);
  if (stepMatch) {
    filter.step = Math.max(0, Math.min(12, parseInt(stepMatch[1], 10)));
    matched++;
    categories.add("step");
    claim(stepMatch);
  }

  const overMin = rest.match(/(over|more than|older than|at least|>=?|than)\s*(\d{1,3})\s*(?:min|mins|minutes?)\b/i);
  if (overMin) {
    filter.minStepMinutes = parseInt(overMin[2], 10);
    filter.minStepMinutesExclusive = !/at least|>=/i.test(overMin[1]);
    matched++;
    categories.add("minutes");
    claim(overMin);
  }

  const overPct = rest.match(/(over|more than|above|at least|>=?)\s*(\d{1,3})\s*(?:%|percent)\s*(?:done|complete|completed|of progress)?/i);
  if (overPct) {
    filter.minProgressPct = Math.min(100, parseInt(overPct[2], 10));
    filter.minProgressExclusive = !/at least|>=/i.test(overPct[1]);
    matched++;
    categories.add("progress");
    claim(overPct);
  }
  const underPct = rest.match(/(under|less than|below|at most|<=?)\s*(\d{1,3})\s*(?:%|percent)/i);
  if (underPct) {
    filter.maxProgressPct = Math.min(100, parseInt(underPct[2], 10));
    filter.maxProgressExclusive = !/at most|<=/i.test(underPct[1]);
    matched++;
    categories.add("progress");
    claim(underPct);
  }

  const spendMatch =
    rest.match(/(cost(?:ing)?|spent|spend|bill(?:ed)?)\s*(over|more than|above|at least|>=?)\s*\$?\s*(\d+(?:\.\d+)?)/i) ||
    rest.match(/(over|above|more than|>=?)\s*\$\s*(\d+(?:\.\d+)?)/i);
  if (spendMatch) {
    const amount = spendMatch[3] ?? spendMatch[2];
    const op = spendMatch[3] ? spendMatch[2] : spendMatch[1];
    filter.minSpend = parseFloat(amount);
    filter.minSpendExclusive = !/at least|>=/i.test(op);
    matched++;
    categories.add("spend");
    claim(spendMatch);
  }

  // Superlative spend questions need no threshold: sort, don't filter.
  const spendTop =
    !spendMatch &&
    /\bmost\s+expensive\b|\b(?:cost|spend|bill)(?:ing|s|ed)?\s+the\s+(?:most|highest)\b|\b(?:highest|biggest|top|largest)\s+(?:spend|spenders?|costs?|bills?)\b|\bspend(?:er|ing)?s?\s+(?:the\s+)?most\b/i.test(
      text,
    );
  if (spendTop) {
    const m = rest.match(/\bmost\s+expensive\b|\b(?:cost|spend|bill)(?:ing|s|ed)?\s+the\s+(?:most|highest)\b|\b(?:highest|biggest|top|largest)\s+(?:spend|spenders?|costs?|bills?)\b|\bspend(?:er|ing)?s?\s+(?:the\s+)?most\b/i);
    if (m) claim(m);
    filter.sort = "spend";
    filter.order = "desc";
    matched++;
    categories.add("spend");
  }

  // A name search can stand alone or combine with other clauses
  // ("failed learner named Priya"). An unparseable name after "named" is an
  // abstain, not a silently dropped clause.
  const nameMatch = rest.match(/(?:named|name is|learner|student)\s+([a-z][a-z .'-]{1,40})/i);
  if (nameMatch) {
    const candidate = nameMatch[1].trim().replace(/^named\s+/i, "");
    const words = candidate.split(/\s+/);
    const stop = new Set(["who", "that", "the", "with", "and", "or", "over", "under", "more", "less", "than", "made", "have", "has", "are", "is"]);
    const looksLikeName = words.length <= 3 && words.length > 0 && !words.some((w) => stop.has(w.toLowerCase()));
    if (looksLikeName) {
      filter.q = candidate;
      matched++;
      categories.add("name");
      claim(nameMatch);
    } else if (/named|name is/i.test(nameMatch[0])) {
      return abstain(
        `I could not read a learner name in that request. Try "learner Priya" on its own, or use the search box.`,
      );
    }
  }

  if (/\s+or\s+/i.test(text) && categories.size > 1) {
    return abstain(
      'I can only combine conditions with AND, not "or". Run them one at a time, e.g. "failed" then "stuck", or try separate searches.',
    );
  }

  if (matched === 0) {
    return abstain(
      'Could not compile that into a filter. Try "failed", "stuck on step 4 over 20 min", "over 50% done", or "costing over $8".',
    );
  }

  // Coverage: every remaining meaningful word must be sentence filler. An
  // unrecognized word means part of the request would be silently ignored,
  // which is worse than saying so.
  const leftover = rest
    .replace(/[^a-z0-9\s$%-]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER.has(w.toLowerCase()) && !/^\d+$/.test(w) && w !== "$" && w !== "%");
  if (leftover.length > 0) {
    return abstain(
      `I understood part of that but not "${leftover.slice(0, 3).join(" ")}". I can filter by state, stuck, step, time on step, progress %, spend, or a learner name.`,
    );
  }

  if (!filter.sort) filter.sort = "risk";
  return {
    ok: true,
    filter,
    description: describeFilter(filter),
    confidence: 0.9,
    source: "local-parser",
    degraded: false,
  };
}
