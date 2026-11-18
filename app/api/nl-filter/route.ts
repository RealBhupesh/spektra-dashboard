import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { analyzeNL, contradictoryProgress, describeFilter, MAX_STEP_MINUTES, type NLResult } from "@/lib/nlparser";
import { STATE_ORDER, TOTAL_STEPS, type FilterQuery } from "@/lib/types";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

type Key = keyof FilterQuery;
type Provider = { base: string; key: string; model: string };

function isLocalBaseUrl(base: string): boolean {
  try {
    const { hostname, protocol, username, password } = new URL(base);
    if (username || password || (protocol !== "http:" && protocol !== "https:")) return false;
    return hostname === "localhost" || hostname === "[::1]" || hostname.endsWith(".local") ||
      (isIP(hostname) === 4 && /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname));
  } catch {
    return false;
  }
}

function llmConfig(): Provider | null {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    return { base: "https://api.groq.com/openai/v1", key: groqKey, model: process.env.GROQ_MODEL || "openai/gpt-oss-120b" };
  }
  const { LLM_BASE_URL: base, LLM_API_KEY: key, LLM_MODEL: model } = process.env;
  return base && key && model && isLocalBaseUrl(base) ? { base, key, model } : null;
}

const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const isBoolean = (value: unknown) => typeof value === "boolean";
const allowedStates = new Set<string>(STATE_ORDER);
const sortedFields = new Set(["risk", "name", "progress", "spend", "stepMinutes"]);
const checks: Record<Key, (value: unknown) => boolean> = {
  states: (v) => Array.isArray(v) && v.length > 0 && v.length <= STATE_ORDER.length &&
    new Set(v).size === v.length && v.every((s) => typeof s === "string" && allowedStates.has(s)),
  q: (v) => typeof v === "string" && v.length >= 2 && v.length <= 60 && v === v.trim() &&
    /\p{L}/u.test(v) && /^[\p{L}\p{N} .@'’-]+$/u.test(v),
  step: (v) => within(v, 1, TOTAL_STEPS) && Number.isInteger(v),
  minStepMinutes: (v) => within(v, 0, MAX_STEP_MINUTES),
  minProgressPct: (v) => within(v, 0, 100),
  maxProgressPct: (v) => within(v, 0, 100),
  minSpend: (v) => within(v, 0, Number.MAX_SAFE_INTEGER),
  minStepMinutesExclusive: isBoolean,
  minProgressExclusive: isBoolean,
  maxProgressExclusive: isBoolean,
  minSpendExclusive: isBoolean,
  stuck: (v) => v === true,
  sort: (v) => typeof v === "string" && sortedFields.has(v),
  order: (v) => v === "asc" || v === "desc",
};
const thresholdFor = {
  minStepMinutesExclusive: "minStepMinutes",
  minProgressExclusive: "minProgressPct",
  maxProgressExclusive: "maxProgressPct",
  minSpendExclusive: "minSpend",
} as const;
const exclusiveKeys = new Set<Key>(Object.keys(thresholdFor) as Key[]);

function validateFilter(raw: unknown): FilterQuery | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (!entries.length || entries.some(([k, v]) => !Object.hasOwn(checks, k) || !checks[k as Key](v))) return null;
  const f = raw as FilterQuery;
  if (f.order !== undefined && f.sort === undefined) return null;
  for (const [flag, field] of Object.entries(thresholdFor)) {
    if (f[flag as Key] !== undefined && f[field] === undefined) return null;
  }
  if (contradictoryProgress(f)) return null;
  return f.sort && !f.order ? { ...f, order: "asc" } : f;
}

async function tryLLM(text: string, { base, key, model }: Provider): Promise<FilterQuery | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Convert the workshop filter request into a JSON object. Include only requested constraints, or output {} if unsupported.",
              "Fields: states (array of provisioning|ready|in_use|failed|deprovisioned), q (learner search), step (integer 1–12), minStepMinutes (0–600), minProgressPct and maxProgressPct (0–100), minSpend (USD, nonnegative), stuck (true), sort (risk|name|progress|spend|stepMinutes), order (asc|desc).",
              "For a strict threshold use the relevant flag: minStepMinutesExclusive, minProgressExclusive, maxProgressExclusive, minSpendExclusive. Preserve the threshold and every clause. Output JSON only.",
            ].join(" "),
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.length <= 4096 ? validateFilter(JSON.parse(content)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Each recognizable request topic must have a corresponding field. This
// vocabulary is intentionally limited; confirmation still covers ambiguity.
const topics: { words: RegExp; keys: Key[]; sort?: FilterQuery["sort"] }[] = [
  { words: /\b(?:progress(?:ed)?|ahead|behind|barely|percent|done|completion)\b|%/i, keys: ["minProgressPct", "maxProgressPct"], sort: "progress" },
  { words: /\b(?:stuck|blocked|slow|waiting|long|idle|parked|lingering|ages|forever)\b|\bsame\s+(?:step|lesson|stage)\b/i, keys: ["stuck", "minStepMinutes"], sort: "stepMinutes" },
  { words: /\bstep\s*\d/i, keys: ["step"] },
  { words: /\d(?:\.\d+)?\s*(?:mins?|minutes?)\b/i, keys: ["minStepMinutes"] },
  { words: /\b(?:cost\w*|spend\w*|spent|bill\w*|expensive|price|budget|spenders?)\b|\$/i, keys: ["minSpend"], sort: "spend" },
  { words: /\b(?:fail\w*|errors?|malfunction\w*|crash\w*|ready|provisioning|deprovisioned|in[-_ ]use|working|finished|powered off)\b/i, keys: ["states"] },
  { words: /\b(?:named|name is|called|learner|student)\s+\p{Lu}[\p{L}'’-]+/u, keys: ["q"] },
  { words: /\b(?:alphabetical(?:ly)?|by name)\b/i, keys: [], sort: "name" },
  { words: /\b(?:risk order|by risk)\b/i, keys: [], sort: "risk" },
];
const sorting = /\b(?:sort\w*|order\w*|rank\w*|highest|lowest|longest|shortest|top|most|least|alphabetical\w*|by (?:name|risk))\b/i;

function matchesIntent(text: string, f: FilterQuery, explicit: FilterQuery): boolean {
  const known = new Set<Key>(Object.keys(explicit) as Key[]);
  for (const key of known) {
    if (key === "states") {
      if (f.states?.length !== explicit.states?.length || !explicit.states?.every((s) => f.states?.includes(s))) return false;
    } else if (key === "q") {
      if (f.q?.toLowerCase() !== explicit.q?.toLowerCase()) return false;
    } else if (exclusiveKeys.has(key)) {
      if (Boolean(f[key]) !== Boolean(explicit[key])) return false;
    } else if (f[key] !== explicit[key]) {
      return false;
    }
  }

  const needed = topics.filter(({ words }) => words.test(text));
  if (!needed.length && !known.size) return false;
  if (/\b(?:barely|behind|little progress)\b/i.test(text) && f.maxProgressPct === undefined) return false;
  if (/\b(?:highest|descending|longest)\b/i.test(text) && f.sort && f.order !== "desc") return false;
  if (/\b(?:lowest|ascending|shortest)\b/i.test(text) && f.sort && f.order !== "asc") return false;
  for (const { keys, sort } of needed) {
    const requestedSort = sort !== undefined && f.sort === sort && sorting.test(text);
    const matched = keys.some((key) => f[key] !== undefined) || requestedSort;
    if (!matched) return false;
    keys.forEach((key) => known.add(key));
    if (requestedSort) {
      known.add("sort");
      known.add("order");
    }
  }
  if (/\band\b/i.test(text) && text.split(/\band\b/i).some((part) =>
    !topics.some(({ words }) => words.test(part)) && !Object.keys(analyzeNL(part).explicit).length)) return false;

  return (Object.keys(f) as Key[]).every((key) => known.has(key) ||
    (exclusiveKeys.has(key) && known.has(thresholdFor[key as keyof typeof thresholdFor])));
}

export async function POST(req: NextRequest) {
  if (!rateLimitOk(`nl:${clientKey(req)}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  let text: string;
  try {
    const body = await req.json();
    if (typeof body?.text !== "string" || !body.text.trim()) return NextResponse.json({ error: "empty_query" }, { status: 400 });
    text = body.text.trim();
    if (text.length > 300) return NextResponse.json({ error: "query_too_long" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { result: local, explicit } = analyzeNL(text);
  if (local.ok || local.terminal) return NextResponse.json(local);
  const provider = llmConfig();
  if (!provider) return NextResponse.json(local);

  const candidate = await tryLLM(text, provider);
  if (candidate && matchesIntent(text, candidate, explicit)) {
    const result: NLResult = {
      ok: true,
      filter: { sort: "risk", ...candidate },
      description: describeFilter(candidate),
      confidence: 0.7,
      source: "llm",
      degraded: false,
      requiresConfirmation: true,
    };
    return NextResponse.json(result);
  }
  return NextResponse.json({
    ...local,
    source: "llm-fallback-local",
    degraded: true,
    message: "The optional model could not suggest a supported filter. Try an exact phrase or use More filters.",
  } satisfies NLResult);
}
