import { EnvState, FilterQuery, TOTAL_STEPS } from "./types";

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
  if (f.sort === "name") d.push(`sorted by learner name, ${f.order === "desc" ? "Z to A" : "A to Z"}`);
  else if (f.sort === "risk") d.push(`sorted by risk, ${f.order === "desc" ? "lowest" : "highest"} first`);
  else if (f.sort) {
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
  // True when this abstain is an intent-safety refusal (negation,
  // cross-category "or"): the caller must NOT escalate it to a model,
  // because a model would happily re-interpret the query and silently
  // change what the instructor asked for.
  terminal?: boolean;
  message?: string;
}

const STATE_WORDS: [RegExp, EnvState][] = [
  [/\bfail(?:ed|ing|ures?)?\b/i, "failed"],
  [/\bin[-_ ]?use\b|\bworking\b/i, "in_use"],
  [/\bready\b/i, "ready"],
  [/\bprovisioning\b|\bspinning up\b|\bstarting up\b/i, "provisioning"],
  [/\bdeprovisioned\b/i, "deprovisioned"],
];

const FILLER = new Set(
  `show me all everyone every any the a an of who are is that with and get list give find learners learner students student
   environments environment env envs labs lab people folks please on in for to their them currently right now much many how
   what which whose still been have has had do does did just only there here see want need display`.split(/\s+/),
);

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const LOWER = String.raw`\bover|\bmore than|\bolder than|\babove|\bat least|>=|>`;
const UPPER = String.raw`\bunder|\bless than|\bbelow|\bat most|<=|<`;
const PERCENT = String.raw`\s*(?:%(?![\p{L}\p{N}])|percent\b)(?:\s+(?:done|complete(?:d)?|of progress)\b)?`;
const SPEND_SORT = /\bmost\s+expensive\b|\b(?:cost|spend|bill)(?:ing|s|ed)?\s+the\s+(?:most|highest)\b|\b(?:highest|biggest|top|largest)\s+(?:spend|spenders?|costs?|bills?)\b|\bspend(?:er|ing)?s?\s+(?:the\s+)?most\b/i;
const NAME_END = /^(?:who|that|the|with|and|or|on|for|over|under|at|more|less|than|failed|stuck|blocked|ready|active|working|provisioning|deprovisioned|in|costing|spending)$/i;
export const MAX_STEP_MINUTES = 600;

export function contradictoryProgress(f: FilterQuery): boolean {
  const { minProgressPct: min, maxProgressPct: max, minProgressExclusive, maxProgressExclusive } = f;
  return (min === 100 && !!minProgressExclusive) || (max === 0 && !!maxProgressExclusive) ||
    (min !== undefined && max !== undefined && (min > max || (min === max && !!(minProgressExclusive || maxProgressExclusive))));
}

export function compileNL(input: string): NLResult {
  return analyzeNL(input).result;
}

// On free-form input, retain the exact recognized clauses for validation of
// a proposed model filter. The HTTP response exposes only a completed filter.
export function analyzeNL(input: string): { result: NLResult; explicit: FilterQuery } {
  const text = input.trim();
  const filter: FilterQuery = {};
  const categories = new Set<string>();
  let rest = ` ${text} `;
  const blank = (start: number, length: number) => {
    rest = rest.slice(0, start) + " ".repeat(length) + rest.slice(start + length);
  };
  const claim = (m: RegExpMatchArray) => blank(m.index!, m[0].length);
  const refuse = (message: string, terminal = false) => ({
    result: { ok: false, filter: {}, description: [], confidence: 0, source: "local-parser", degraded: false, terminal, message } as NLResult,
    explicit: filter,
  });
  const invalid = () => refuse("That request has an unsupported, repeated, or out-of-range constraint. Try one condition per field using More filters.", true);
  const negProbe = text.replace(/\b(?:not moving|no progress)\b/gi, " ");
  if (/\b(?:not|no|never|neither|nor|except|excluding|without|other than)\b|n['’]t\b/i.test(negProbe)) {
    return refuse('I cannot compile negation safely. Try the state you want to see, or use the state buttons.', true);
  }

  // Recognize explicit learner names before interpreting state words.
  const nameMark = rest.match(/\b(?:named|name is|called)\b/i);
  if (nameMark) {
    const start = nameMark.index! + nameMark[0].length;
    const name = rest.slice(start).match(/^(\s+)([\p{L}]['’\p{L}-]*(?:[ \t]+[\p{L}]['’\p{L}-]*){0,2})/u);
    const words = [...(name?.[2].matchAll(/\S+/g) ?? [])];
    const end = words.findIndex(([word]) => NAME_END.test(word));
    const selected = end === -1 ? words : words.slice(0, end);
    const candidate = selected.map(([word]) => word).join(" ");
    const last = selected.at(-1);
    if (!name || !last || candidate.length < 2 || candidate.length > 60) {
      return refuse('I could not read a learner name. Try "learner Priya" or use the search box.', true);
    }
    blank(nameMark.index!, nameMark[0].length + name[1].length + last.index + last[0].length);
    filter.q = candidate;
    categories.add("name");
  }

  const states: { state: EnvState; start: number; end: number }[] = [];
  for (const [re, state] of STATE_WORDS) {
    const m = rest.match(re);
    if (!m) continue;
    states.push({ state, start: m.index!, end: m.index! + m[0].length });
    claim(m);
  }
  if (states.length) {
    states.sort((a, b) => a.start - b.start);
    if (states.slice(1).some((s, i) => !/\bor\b/i.test(rest.slice(states[i].end, s.start)) || /\band\b/i.test(rest.slice(states[i].end, s.start)))) {
      return refuse('Use "or" between alternative states, or choose one state.', true);
    }
    filter.states = states.map((s) => s.state);
    categories.add("state");
  }
  const stuck = rest.match(/\b(?:stuck|blocked|not moving|no progress)\b/i);
  if (stuck) {
    filter.stuck = true;
    categories.add("stuck");
    claim(stuck);
  }

  const step = rest.match(new RegExp(String.raw`\bstep\s*(${NUMBER})(?![\p{L}\p{N}]|\.\d)`, "iu"));
  if (step) {
    const n = Number(step[1]);
    if (!Number.isInteger(n) || n < 1 || n > TOTAL_STEPS) return invalid();
    filter.step = n;
    categories.add("step");
    claim(step);
  }

  const bound = (pattern: RegExp, key: "minStepMinutes" | "minProgressPct" | "maxProgressPct" | "minSpend",
    exclusive: "minStepMinutesExclusive" | "minProgressExclusive" | "maxProgressExclusive" | "minSpendExclusive",
    category: string, max: number, suffix?: RegExp) => {
    const prefix = rest.match(pattern);
    const m = prefix ?? (suffix && rest.match(suffix));
    if (!m) return true;
    const n = Number(prefix ? m[2] ?? m[4] : m[1]);
    if (!Number.isFinite(n) || n > max) return false;
    filter[key] = n;
    filter[exclusive] = !!prefix && !/^(?:at (?:least|most)|>=|<=)$/i.test(m[1] ?? m[3]);
    categories.add(category);
    claim(m);
    return true;
  };

  if (!bound(new RegExp(String.raw`(${LOWER})\s*(${NUMBER})\s*(?:min|mins|minutes?)\b`, "i"),
    "minStepMinutes", "minStepMinutesExclusive", "minutes", MAX_STEP_MINUTES)) return invalid();
  if (!bound(new RegExp(String.raw`(${LOWER})\s*(${NUMBER})${PERCENT}`, "iu"),
    "minProgressPct", "minProgressExclusive", "progress", 100,
    new RegExp(String.raw`(${NUMBER})${PERCENT}\s+or\s+(?:more|higher|above)\b`, "iu"))) return invalid();
  if (!bound(new RegExp(String.raw`(${UPPER})\s*(${NUMBER})${PERCENT}`, "iu"),
    "maxProgressPct", "maxProgressExclusive", "progress", 100,
    new RegExp(String.raw`(${NUMBER})${PERCENT}\s+or\s+(?:less|lower|below)\b`, "iu"))) return invalid();
  if (!bound(new RegExp(String.raw`(?:\b(?:cost(?:ing)?|spent|spend|bill(?:ed)?)\s+(${LOWER})\s*\$?\s*(${NUMBER})|(${LOWER})\s*\$\s*(${NUMBER}))(?![\p{L}\p{N}]|[.,]\d)`, "iu"),
    "minSpend", "minSpendExclusive", "spend", Number.MAX_SAFE_INTEGER)) return invalid();

  const sort = rest.match(SPEND_SORT);
  if (sort) {
    filter.sort = "spend";
    filter.order = "desc";
    categories.add("spend");
    claim(sort);
  }
  if (!filter.q) {
    const name = rest.match(/\b(?:learner|student)\s+([\p{L}][\p{L} ’'-]{1,59})$/iu);
    const candidate = name?.[1].trim();
    const words = candidate?.split(/\s+/);
    if (name && candidate && words && words.length <= 3 && !words.some((w) => FILLER.has(w.toLowerCase()) || NAME_END.test(w))) {
      filter.q = candidate;
      categories.add("name");
      claim(name);
    }
  }

  if (contradictoryProgress(filter)) return refuse("The progress bounds do not overlap. Change one of the thresholds.", true);
  if (/\bactive\b/i.test(rest)) return refuse('Choose a specific state, such as "in use" or "ready", for an active PC.', true);
  if (/\bor\b/i.test(rest)) {
    const mutableClause = categories.size !== 1 || !categories.has("state") || states.length < 2;
    if (mutableClause) return refuse('I can only combine conditions with AND. Run them one at a time, or use "or" between alternative states.', true);
    rest = rest.replace(/\bor\b/gi, " ");
  }
  if (/[\p{N}$%<>≤≥=+]|\b(?:over|under|above|below|at least|at most|older than|more than|less than|on step|named|name is|called|zero|one|two|three|four|five|six|seven|eight|nine|ten|twice|thrice|hundred)\b/iu.test(rest) || /\b(?:and|or)\s*[.!?]*$/i.test(text)) return invalid();

  const leftover = (rest.match(/[\p{L}’'-]+/gu) ?? []).filter((word) => !FILLER.has(word.toLowerCase()));
  if (leftover.length && states.length > 1) return invalid();
  if (!categories.size) {
    return refuse('Could not compile that into a filter. Try "failed", "stuck on step 4 over 20 min", or "costing over $8".');
  }
  if (leftover.length) {
    return refuse(`I understood part of that but not "${leftover.slice(0, 3).join(" ")}". You can use the manual filters below.`);
  }

  return {
    result: { ok: true, filter: { sort: "risk", ...filter }, description: describeFilter(filter), confidence: 0.9, source: "local-parser", degraded: false },
    explicit: filter,
  };
}
