import { NextRequest, NextResponse } from "next/server";
import { compileNL, describeFilter, NLResult } from "@/lib/nlparser";
import { FilterQuery } from "@/lib/types";

export const dynamic = "force-dynamic";

// Optional LLM tier. Unset by default: the repo runs fully offline on the
// local compiler. When LLM_BASE_URL + LLM_API_KEY + LLM_MODEL are set (any
// OpenAI-compatible endpoint), the model is asked for the SAME FilterQuery
// JSON shape, strictly validated, and any failure falls back to the local
// compiler instead of failing the dashboard.
async function tryLLM(text: string): Promise<FilterQuery | null> {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!base || !key || !model) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000); // CPU-local models can be slow on first token
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Convert an instructor dashboard filter request into JSON. Optional keys: states (array of provisioning|ready|in_use|failed|deprovisioned), q (name search string), step (1-12), minStepMinutes (number), minProgressPct (0-100), maxProgressPct (0-100), minSpend (number), stuck (boolean). Only include keys the request actually asks for. Output JSON only, no explanation.',
          },
          { role: "user", content: "everyone stuck on step 4 over 20 min" },
          { role: "assistant", content: '{"stuck":true,"step":4,"minStepMinutes":20}' },
          { role: "user", content: "failed environments" },
          { role: "assistant", content: '{"states":["failed"]}' },
          { role: "user", content: "learners who barely made any progress" },
          { role: "assistant", content: '{"maxProgressPct":15}' },
          { role: "user", content: "show me the big spenders" },
          { role: "assistant", content: '{"minSpend":5}' },
          { role: "user", content: "students who finished everything" },
          { role: "assistant", content: '{"states":["deprovisioned"]}' },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    // Strict validation: keep only known keys with sane types.
    const out: FilterQuery = {};
    const validStates = new Set(["provisioning", "ready", "in_use", "failed", "deprovisioned"]);
    if (Array.isArray(raw.states)) {
      const s = raw.states.filter((x: unknown) => typeof x === "string" && validStates.has(x));
      if (s.length) out.states = s;
    }
    // Reject degenerate values a small model emits when guessing: they are
    // either no-ops (min*: 0, maxProgressPct: 100) or query-killers (q "0").
    if (typeof raw.q === "string" && raw.q.length >= 2 && raw.q.length <= 60) out.q = raw.q;
    for (const k of ["step", "minStepMinutes", "minProgressPct", "minSpend"] as const) {
      if (typeof raw[k] === "number" && Number.isFinite(raw[k]) && raw[k] > 0) out[k] = raw[k];
    }
    if (typeof raw.maxProgressPct === "number" && Number.isFinite(raw.maxProgressPct) && raw.maxProgressPct < 100) {
      out.maxProgressPct = raw.maxProgressPct;
    }
    if (raw.stuck === true) out.stuck = true;
    return Object.keys(out).length ? out : null;
  } catch {
    return null; // model down, slow, or bad JSON: degrade, never break
  } finally {
    clearTimeout(timeout);
  }
}

// Map query vocabulary to the FilterQuery keys a correct compilation would
// use. Small local models are confidently wrong often enough that output
// which ignores the query's own intent words is rejected instead of shown.
function intentHints(text: string): Set<string> {
  const t = text.toLowerCase();
  const keys = new Set<string>();
  if (/progress|done|complete|finish|barely|started|behind|ahead|far along/.test(t)) {
    keys.add("minProgressPct").add("maxProgressPct");
  }
  if (/stuck|blocked|slow|waiting|long|idle/.test(t)) keys.add("stuck").add("minStepMinutes");
  if (/step\s*\d/.test(t)) keys.add("step");
  if (/\d+\s*(min|mins|minutes|hour|hours)/.test(t)) keys.add("minStepMinutes");
  if (/cost|spend|spent|bill|\$|expensive|price|budget/.test(t)) keys.add("minSpend");
  if (/fail|broken|error|down|crash/.test(t)) keys.add("states");
  if (/ready|provision|deprovision|in use|active|finished|done|complete/.test(t)) keys.add("states");
  if (/named|name|called|env-\d+|^[a-z]+ [a-z]+$/.test(t)) keys.add("q");
  return keys;
}

export async function POST(req: NextRequest) {
  let text = "";
  try {
    const body = await req.json();
    text = typeof body?.text === "string" ? body.text.slice(0, 300) : "";
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ error: "empty_query" }, { status: 400 });
  }

  // Tier 1: the deterministic compiler handles the canonical phrasings and
  // is always right about what it matched.
  const local = compileNL(text);
  if (local.ok) return NextResponse.json(local);

  // Tier 2: the model (when configured) handles free-form phrasing. Its
  // output is described in plain language and must be confirmed in the UI
  // before it is applied - a small local model can be confidently wrong.
  const llm = await tryLLM(text);
  if (llm) {
    const hints = intentHints(text);
    const modelKeys = Object.keys(llm).filter((k) => k !== "sort");
    const onTopic = hints.size > 0 && modelKeys.some((k) => hints.has(k));
    if (!onTopic) {
      // Semantics check failed: the model ignored what the query is about.
      // Abstain plainly rather than show a schema-valid but wrong filter.
      return NextResponse.json({
        ok: false,
        filter: {},
        description: [],
        confidence: 0,
        source: "llm",
        degraded: false,
        message:
          "The model could not confidently map that onto dashboard fields (state, step, time on step, progress %, spend, or a learner name). Try naming one of those, e.g. \"under 20% done\" or \"costing over $6\".",
      } satisfies NLResult);
    }
    const result: NLResult = {
      ok: true,
      filter: { ...llm, sort: "risk" },
      description: describeFilter(llm),
      confidence: 0.7,
      source: "llm",
      degraded: false,
      requiresConfirmation: true,
    };
    return NextResponse.json(result);
  }

  // Nothing compiled the query: fail safe, manual filters keep working.
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) {
    local.source = "llm-fallback-local";
    local.degraded = true;
  }
  return NextResponse.json(local);
}
