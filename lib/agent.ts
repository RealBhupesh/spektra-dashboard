// Server-side simulation assistant for the instructor dashboard.
//
// Authority model: the language model never touches state and never states
// facts. Every number, name and state in a reply is rendered server-side from
// a computed snapshot; the model only classifies the question's intent and
// may add a short fact-free lead-in. The only mutation is `reprovision` of an
// environment that is FAILED, executed through lib/store.ts (the same
// durable, append-only, session-scoped log the REST route uses). Immediate
// execution happens only when the user's own words are an unambiguous
// directive parsed HERE (never inferred by the model); otherwise actions come
// back as proposals and run only when the UI echoes them via `confirm`,
// revalidated against live state at write time.
//
// Pure addition: reuses store/filters/nlparser and duplicates only the small
// provider-config helper from the nl-filter route so the patch touches no
// existing file. Behavior without a configured provider is a deterministic
// local responder, reported as source "local" so the UI can label it.

import { isIP } from "node:net";
import { getSnapshot, reprovision, summarizeSnapshot } from "./store";
import { isStuck, onStepMinutes, progressPct, spendUsd } from "./filters";
import { analyzeNL, describeFilter } from "./nlparser";
import { LAB_STEPS } from "./seed";
import { Environment, EnvState, FilterQuery, SessionSummary, STUCK_MINUTES, TOTAL_STEPS } from "./types";

export const AGENT_MAX_MESSAGE = 500;
export const AGENT_MAX_ACTIONS = 25;
const ID_RE = /^env-\d{3}$/;

export interface AgentProposedAction {
  kind: "reprovision";
  ids: string[];
  label: string;
}

export interface AgentExecutedAction {
  kind: "reprovision";
  id: string;
  learnerName: string;
  ok: boolean;
  resultingState?: EnvState;
  skippedReason?: string;
  error?: string;
}

export interface AgentResponse {
  ok: true;
  reply: string;
  source: "llm" | "local";
  degraded: boolean;
  now: number;
  // stateVersion is the action-log length BEFORE this request; after any
  // executions stateVersionAfter is the ACTUAL post-append log length read
  // back from the store, never before-plus-count arithmetic.
  stateVersion: number;
  stateVersionAfter: number;
  summary: SessionSummary;
  selected: Record<string, unknown> | null;
  suggestedFilter: { filter: FilterQuery; description: string[] } | null;
  proposedActions: AgentProposedAction[];
  executedActions: AgentExecutedAction[];
  actionsAppended: { id: string; at: number }[];
  refreshRequired: boolean;
}

export class AgentInputError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = "AgentInputError";
  }
}

export interface AgentConfirm {
  kind: "reprovision";
  ids: string[];
}

export interface AgentRequest {
  message: string | null;
  selectedId: string | null;
  confirm: AgentConfirm | null;
}

export function parseAgentBody(raw: unknown): AgentRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AgentInputError("bad_request");
  const body = raw as Record<string, unknown>;

  let confirm: AgentConfirm | null = null;
  if (body.confirm !== undefined && body.confirm !== null) {
    const c = body.confirm as Record<string, unknown>;
    if (typeof c !== "object" || c === null || Array.isArray(c)) throw new AgentInputError("bad_request");
    if (c.kind !== "reprovision") throw new AgentInputError("unknown_action_kind");
    if (!Array.isArray(c.ids) || c.ids.length === 0) throw new AgentInputError("bad_request");
    if (c.ids.length > AGENT_MAX_ACTIONS) throw new AgentInputError("too_many_actions");
    const ids = c.ids.map((v) => (typeof v === "string" ? v.toLowerCase().trim() : ""));
    if (ids.some((id) => !ID_RE.test(id)) || new Set(ids).size !== ids.length) throw new AgentInputError("bad_request");
    confirm = { kind: "reprovision", ids };
  }

  let message: string | null = null;
  if (body.message !== undefined && body.message !== null) {
    if (typeof body.message !== "string") throw new AgentInputError("bad_request");
    message = body.message.trim();
    if (!message) throw new AgentInputError("empty_message");
    if (message.length > AGENT_MAX_MESSAGE) throw new AgentInputError("message_too_long");
  }
  if (!message && !confirm) throw new AgentInputError("empty_message");

  let selectedId: string | null = null;
  if (body.selectedId !== undefined && body.selectedId !== null) {
    if (typeof body.selectedId !== "string" || !ID_RE.test(body.selectedId.toLowerCase().trim())) {
      throw new AgentInputError("bad_request");
    }
    selectedId = body.selectedId.toLowerCase().trim();
  }
  return { message, selectedId, confirm };
}

// ---------- snapshot-derived context (the only facts replies may use) ----------

interface AgentContext {
  now: number;
  stateVersion: number;
  summary: SessionSummary;
  all: Environment[];
  failed: Environment[];
  stuck: Environment[];
  selected: Environment | null;
}

function enrich(e: Environment, now: number): Record<string, unknown> {
  return {
    ...e,
    spendUsd: Math.round(spendUsd(e) * 100) / 100,
    progressPct: progressPct(e),
    onStepMinutes: Math.floor(onStepMinutes(e, now) * 10) / 10,
    stuck: isStuck(e, now),
  };
}

function buildContext(snapshot: Awaited<ReturnType<typeof getSnapshot>>, selectedId: string | null): AgentContext {
  const { now, environments } = snapshot;
  const selected = selectedId ? environments.find((e) => e.id === selectedId) ?? null : null;
  if (selectedId && !selected) throw new AgentInputError("unknown_selected", 404);
  return {
    now,
    stateVersion: snapshot.stateVersion,
    summary: summarizeSnapshot(snapshot),
    all: environments,
    failed: environments.filter((e) => e.state === "failed"),
    stuck: environments.filter((e) => isStuck(e, now)),
    selected,
  };
}

// ---------- directive parsing (server-side authority for execution) ----------

const VERB = "(?:restart|reprovision|reset|reboot|fix(?:es)?|repair|revive|recover|bring\\s+back|power\\s+on|turn\\s+on|start\\s+up)";
const DIRECTIVE_RE = new RegExp(`\\b${VERB}\\b`, "i");
// A negation scoped to the directive verb: "don't restart", "never fix",
// "please do not reboot". A bare "not" elsewhere must not cancel a directive.
const NEGATED_RE = new RegExp(
  `\\b(?:don'?t|do\\s+not|never|no\\s+need\\s+to|stop|avoid|leave|refrain\\s+from)\\b[^.!?;]{0,40}?\\b${VERB}\\b`,
  "i",
);
// Hypotheticals / information-seeking about the action, not a command.
const HYPOTHETICAL_RE = new RegExp(`\\b(?:what\\s+(?:happens|would)|why\\s+(?:would|did)|should\\s+i)\\b[^.!?;]{0,60}?\\b${VERB}\\b`, "i");

export function looksLikeDirective(message: string): boolean {
  return DIRECTIVE_RE.test(message) && !NEGATED_RE.test(message) && !HYPOTHETICAL_RE.test(message);
}

const THIS_RE = /\b(?:this|that|it|this pc|that pc|this one|the selected|the pc|the workstation|the computer)\b/i;
const ALL_RE = /\b(?:all|every|everything|them|those|each)\b/i;
// Domain vocabulary (matches the existing UI: components/ui.tsx calls
// deprovisioned "Finished" - "PC is switched off and no longer billing", and
// the floor map paints deprovisioned with --off). OFF = deprovisioned, never
// a repair target. FAILED = broken but still on and billing.
const FAILED_WORDS_RE = /\b(?:failed|failure|failures|down|crashed|broken|dead|errored?)\b/i;
const OFF_RE = /\b(?:off|switched\s+off|shut\s?down|powered\s+off|turned\s+off)\b/i;

type Targets =
  | { kind: "ids"; ids: string[] }
  | { kind: "ambiguous"; reason: string }
  | { kind: "none" };

function resolveTargets(message: string, ctx: AgentContext, selectedId: string | null, all: Environment[]): Targets {
  // Explicit environment ids win.
  const explicit = [...new Set((message.toLowerCase().match(/env-\d{3}/g) ?? []))];
  if (explicit.length) return { kind: "ids", ids: explicit.filter((id) => all.some((e) => e.id === id)) };

  // Learner name mention (unique match required).
  const lower = message.toLowerCase();
  const nameHits = all.filter(
    (e) =>
      lower.includes(e.learnerName.toLowerCase()) ||
      e.learnerName.split(" ").some((part) => part.length >= 3 && new RegExp(`\\b${part.toLowerCase()}\\b`).test(lower)),
  );
  if (nameHits.length === 1) return { kind: "ids", ids: [nameHits[0].id] };
  if (nameHits.length > 1) {
    return { kind: "ambiguous", reason: `that matches ${nameHits.slice(0, 4).map((e) => `${e.learnerName} (${e.id})`).join(", ")}${nameHits.length > 4 ? ` and ${nameHits.length - 4} more` : ""}` };
  }

  // Whole-scope words combined with failure words: "restart the failed ones".
  if (FAILED_WORDS_RE.test(message) && (ALL_RE.test(message) || /\bthe\b/i.test(message))) {
    return { kind: "ids", ids: ctx.failed.map((e) => e.id) };
  }

  // "the off ones" targets finished (deprovisioned) PCs - resolvable, so the
  // handler can explain truthfully that off PCs are not repair targets.
  if (OFF_RE.test(message) && (ALL_RE.test(message) || /\bthe\b/i.test(message))) {
    return { kind: "ids", ids: all.filter((e) => e.state === "deprovisioned").map((e) => e.id) };
  }

  // "fix this PC" needs the focused workstation.
  if (THIS_RE.test(message)) {
    if (selectedId && ctx.selected) return { kind: "ids", ids: [selectedId] };
    return { kind: "ambiguous", reason: "no workstation is selected - pick one in the room or name it (env-###)" };
  }

  // Directive verb with only failure words, e.g. "fix everything broken".
  if (FAILED_WORDS_RE.test(message) && ctx.failed.length) return { kind: "ids", ids: ctx.failed.map((e) => e.id) };
  if (OFF_RE.test(message)) return { kind: "ids", ids: all.filter((e) => e.state === "deprovisioned").map((e) => e.id) };
  if (selectedId && ctx.selected) return { kind: "ids", ids: [selectedId] };
  return { kind: "none" };
}

// ---------- execution (always server-validated, always through the store) ----------

async function executeReprovisions(
  ids: string[],
  all: Environment[],
  now: number,
  demoId: string | null,
): Promise<{ executed: AgentExecutedAction[]; appended: { id: string; at: number }[] }> {
  const executed: AgentExecutedAction[] = [];
  const appended: { id: string; at: number }[] = [];
  for (const id of ids.slice(0, AGENT_MAX_ACTIONS)) {
    const known = all.find((e) => e.id === id);
    if (!known) {
      executed.push({ kind: "reprovision", id, learnerName: "", ok: false, skippedReason: "unknown environment" });
      continue;
    }
    try {
      // The store re-checks state at write time and no-ops unless failed, so
      // a concurrently recovered (or concurrently restarted) environment is
      // reported, never restarted twice.
      const updated = await reprovision(id, now, demoId);
      if (!updated) {
        executed.push({ kind: "reprovision", id, learnerName: known.learnerName, ok: false, skippedReason: "unknown environment" });
      } else if (!updated.action) {
        executed.push({
          kind: "reprovision",
          id,
          learnerName: known.learnerName,
          ok: false,
          skippedReason: `already ${updated.environment.state.replace("_", " ")} (not failed)`,
        });
      } else {
        appended.push(updated.action);
        executed.push({
          kind: "reprovision",
          id,
          learnerName: known.learnerName,
          ok: true,
          // Truthful progression: a restart moves the environment to
          // provisioning. It is never reported as recovered or "fixed".
          resultingState: updated.environment.state,
        });
      }
    } catch (err) {
      executed.push({
        kind: "reprovision",
        id,
        learnerName: known.learnerName,
        ok: false,
        error: err instanceof Error && err.message === "persist_failed" ? "persist_failed" : "persist_unavailable",
      });
    }
  }
  return { executed, appended };
}

function executionReply(executed: AgentExecutedAction[]): string {
  const ok = executed.filter((a) => a.ok);
  const skipped = executed.filter((a) => !a.ok && a.skippedReason);
  const errored = executed.filter((a) => !a.ok && a.error);
  const parts: string[] = [];
  if (ok.length) {
    const names = ok.slice(0, 5).map((a) => `${a.id} (${a.learnerName})`).join(", ");
    parts.push(
      `Restarting ${ok.length} failed environment${ok.length === 1 ? "" : "s"}: ${names}${ok.length > 5 ? ` and ${ok.length - 5} more` : ""}. ` +
        `They are now provisioning - a restart in progress, not yet recovered.`,
    );
  }
  if (skipped.length) {
    parts.push(`Skipped ${skipped.length}: ${skipped.slice(0, 3).map((a) => `${a.id} ${a.skippedReason}`).join("; ")}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""}.`);
  }
  if (errored.length) {
    parts.push(`Could not save ${errored.length} restart${errored.length === 1 ? "" : "s"} - storage unavailable, nothing changed for those.`);
  }
  return parts.join(" ");
}

// ---------- intents and deterministic rendering ----------
// Every factual claim in a reply comes from these renderers, fed by the
// computed snapshot. The model may pick an intent; it may never write facts.

type Intent =
  | "mixed_off_failed"
  | "off_counts"
  | "failed_counts"
  | "failed_list"
  | "stuck"
  | "spend"
  | "progress"
  | "active_counts"
  | "status"
  | "selected_detail"
  | "attention"
  | "help"
  | "unknown";

const INTENT_SET = new Set<Intent>([
  "mixed_off_failed", "off_counts", "failed_counts", "failed_list", "stuck", "spend",
  "progress", "active_counts", "status", "selected_detail", "attention", "help", "unknown",
]);

const SHOW_WORDS = /\bshow|filter|highlight|only|list|which\b/i;

// Returns null when no intent matches confidently; only then is the model
// consulted, which keeps common questions instant and free.
function localIntent(message: string, ctx: AgentContext): Intent | null {
  const m = message.toLowerCase();
  if (ctx.selected && (/\b(?:this|that|this pc|that pc|selected|workstation)\b/.test(m) || /\bgoing on|happening|wrong|problem|issue\b/.test(m))) {
    return "selected_detail";
  }
  const hasOff = OFF_RE.test(m);
  const hasFailed = FAILED_WORDS_RE.test(m);
  if (hasOff && hasFailed) return "mixed_off_failed";
  if (hasOff) return "off_counts";
  if (hasFailed) return /\bwhich|list|show|who|names?\b/.test(m) ? "failed_list" : "failed_counts";
  if (/\bstuck|frozen|same step|stall|waiting\b/.test(m)) return "stuck";
  if (/\bcost|spend|spent|bill|price|budget|\$\b/.test(m)) return "spend";
  if (/\bprogress|complete|completion|done|finish|percent|%\b/.test(m)) return "progress";
  if (/\bactive|running|working|alive|online\b/.test(m)) return "active_counts";
  if (/\bstatus|overview|summary|what'?s happening|what is happening|going on|report|how are\b/.test(m)) return "status";
  if (/\bhelp|what can you|hello|\bhi\b|hey\b/.test(m)) return "help";
  return null;
}

const fmtList = (envs: Environment[], now: number, cap = 6): string =>
  envs.slice(0, cap).map((e) => `${e.learnerName} (${e.id}, step ${e.step}${e.failureReason ? `, ${e.failureReason}` : `, ${Math.floor(onStepMinutes(e, now))}m on step`})`).join("; ");

function renderIntent(intent: Intent, message: string, ctx: AgentContext): { reply: string; wantsFilter: boolean } {
  const m = message.toLowerCase();
  const s = ctx.summary;
  const failedN = s.byState.failed;
  const offN = s.byState.deprovisioned;

  switch (intent) {
    case "selected_detail": {
      if (!ctx.selected) return renderIntent("status", message, ctx);
      const e = ctx.selected;
      const stepName = e.step >= 1 && e.step <= TOTAL_STEPS ? ` (${LAB_STEPS[e.step - 1]})` : "";
      const bits = [
        `${e.learnerName}'s PC ${e.id} is ${e.state.replace("_", " ")}`,
        e.state === "in_use" || e.state === "failed" ? `on step ${e.step} of ${e.totalSteps}${stepName} for ${Math.floor(onStepMinutes(e, ctx.now))} minutes` : `at ${progressPct(e)}% completion`,
      ];
      if (e.failureReason) bits.push(`failure: ${e.failureReason}`);
      if (isStuck(e, ctx.now)) bits.push(`flagged stuck (${STUCK_MINUTES}+ min on this step)`);
      bits.push(`spend so far $${(Math.round(spendUsd(e) * 100) / 100).toFixed(2)}`);
      if (e.state === "failed") bits.push("say \"fix this PC\" and I'll restart it");
      if (e.state === "deprovisioned") bits.push("finished and switched off - nothing to restart");
      return { reply: bits.join(", ") + ".", wantsFilter: false };
    }

    case "mixed_off_failed": {
      const healthy = s.active - failedN;
      return {
        reply: `${offN} of ${s.total} PCs are off (finished labs - deprovisioned, no longer billing). ${failedN} ${failedN === 1 ? "is" : "are"} failed (broken but still on and billing)${failedN ? " - say \"restart the failed ones\" and I'll restart them" : ""}. The other ${healthy} are on and working.`,
        wantsFilter: false,
      };
    }

    case "off_counts":
      return {
        reply: `${offN} of ${s.total} PCs are off (finished labs - deprovisioned, no longer billing); ${s.active} are not off. Of the ones on, ${failedN} ${failedN === 1 ? "is" : "are"} failed${failedN ? " - say \"restart the failed ones\" and I'll restart them" : ""}.`,
        wantsFilter: SHOW_WORDS.test(m),
      };

    case "failed_counts": {
      const notFailedN = s.total - failedN;
      return {
        reply: `${failedN} of ${s.total} PCs are failed (broken but still on and billing); ${notFailedN} are not failed.`,
        wantsFilter: SHOW_WORDS.test(m),
      };
    }

    case "failed_list": {
      const notFailedN = s.total - failedN;
      const base = `${failedN} of ${s.total} PCs are failed (broken but still on and billing); ${notFailedN} are not failed.`;
      const list = ctx.failed.length ? ` Failed: ${fmtList(ctx.failed, ctx.now)}${ctx.failed.length > 6 ? `; and ${ctx.failed.length - 6} more` : ""}.` : "";
      return { reply: base + list, wantsFilter: true };
    }

    case "stuck": {
      if (!s.stuckCount) return { reply: "No learners are stuck right now (nobody 20+ minutes on the same step).", wantsFilter: false };
      const base = `${s.stuckCount} learner${s.stuckCount === 1 ? " is" : "s are"} stuck (20+ minutes on the same step): ${fmtList(ctx.stuck, ctx.now)}${ctx.stuck.length > 6 ? `; and ${ctx.stuck.length - 6} more` : ""}.`;
      return { reply: `${base} Stuck is not a failure - they usually recover on their own.`, wantsFilter: SHOW_WORDS.test(m) };
    }

    case "spend":
      return { reply: `Estimated simulated spend so far is $${s.estimatedSpend.toFixed(2)} across ${s.active} active environments.`, wantsFilter: false };

    case "progress":
      return { reply: `Average completion is ${s.avgCompletionPct}% across all ${s.total} learners; ${offN} have finished and been deprovisioned.`, wantsFilter: false };

    case "active_counts":
      return { reply: `${s.active} of ${s.total} environments are active (${s.byState.in_use} in use, ${s.byState.ready} ready, ${s.byState.provisioning} provisioning); ${offN} are deprovisioned.`, wantsFilter: false };

    case "status":
      return {
        reply: `Cohort status: ${s.byState.in_use} in use, ${s.byState.ready} ready, ${s.byState.provisioning} provisioning, ${failedN} failed, ${offN} deprovisioned (of ${s.total}). ${s.stuckCount} stuck, average completion ${s.avgCompletionPct}%, estimated spend $${s.estimatedSpend.toFixed(2)}.`,
        wantsFilter: false,
      };

    case "attention": {
      const parts: string[] = [];
      if (failedN) parts.push(`${failedN} failed PC${failedN === 1 ? "" : "s"} need${failedN === 1 ? "s" : ""} a restart`);
      if (s.stuckCount) parts.push(`${s.stuckCount} learner${s.stuckCount === 1 ? " is" : "s are"} stuck 20+ min on the same step`);
      if (!parts.length) {
        return { reply: `Nothing needs attention: no failures, nobody stuck. ${s.byState.in_use} in use, average completion ${s.avgCompletionPct}%.`, wantsFilter: false };
      }
      const named = [...ctx.failed, ...ctx.stuck].slice(0, 4);
      return { reply: `Watch: ${parts.join("; ")}. ${fmtList(named, ctx.now, 4)}.`, wantsFilter: false };
    }

    case "help":
      return {
        reply: "I can answer about the live simulation: how many PCs are off, failed, stuck, active or done; spend and progress; details on the workstation you selected. And I can restart failed PCs when you tell me to - only simulated restarts, always shown truthfully.",
        wantsFilter: false,
      };

    default:
      return {
        reply: `Here's where things stand: ${failedN} failed, ${s.stuckCount} stuck, ${s.active} active of ${s.total}. Ask me about failures, stuck learners, spend, progress, or any PC you select.`,
        wantsFilter: false,
      };
  }
}

// ---------- provider (same config contract as the nl-filter route) ----------

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
    return {
      base: "https://api.groq.com/openai/v1",
      key: groqKey,
      model: process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    };
  }
  const { LLM_BASE_URL: base, LLM_API_KEY: key, LLM_MODEL: model } = process.env;
  return base && key && model && isLocalBaseUrl(base) ? { base, key, model } : null;
}

function factsJson(ctx: AgentContext): string {
  const s = ctx.summary;
  const envBrief = (e: Environment) => ({
    id: e.id,
    learner: e.learnerName,
    state: e.state,
    step: e.step,
    stepName: e.step >= 1 && e.step <= TOTAL_STEPS ? LAB_STEPS[e.step - 1] : null,
    failureReason: e.failureReason,
    onStepMinutes: Math.floor(onStepMinutes(e, ctx.now)),
    progressPct: progressPct(e),
    spendUsd: Math.round(spendUsd(e) * 100) / 100,
  });
  return JSON.stringify({
    session: s.sessionName,
    totals: {
      pcs: s.total,
      active: s.active,
      on: s.active,
      off: s.byState.deprovisioned,
      failed: s.byState.failed,
      stuck: s.stuckCount,
      provisioning: s.byState.provisioning,
      ready: s.byState.ready,
      inUse: s.byState.in_use,
      deprovisioned: s.byState.deprovisioned,
      avgCompletionPct: s.avgCompletionPct,
      estimatedSpendUsd: s.estimatedSpend,
    },
    selectedEnvironment: ctx.selected ? envBrief(ctx.selected) : null,
    failedEnvironments: ctx.failed.map(envBrief),
    stuckLearners: ctx.stuck.map(envBrief),
  });
}

interface ModelAnswer {
  intent: Intent;
  suggestFilter: boolean;
  proposeRestartIds: string[];
}

// Zero model prose reaches a reply. The model classifies into a fixed intent
// enum and may flag filter/restart suggestions; every word the user reads is
// rendered server-side from the computed snapshot. Any free-text field the
// model returns is ignored, not sanitized - a plausible-sounding false claim
// needs no digits, names or markdown to be wrong.

async function tryLLM(message: string, ctx: AgentContext, provider: Provider): Promise<ModelAnswer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${provider.base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You classify instructor messages for a SIMULATED workshop dashboard (120 fake Azure lab environments, called PCs). The server renders all factual answers from verified data; you never state facts yourself.",
              'Output JSON only: {"intent": one of "mixed_off_failed"|"off_counts"|"failed_counts"|"failed_list"|"stuck"|"spend"|"progress"|"active_counts"|"status"|"selected_detail"|"attention"|"help"|"unknown", "suggestFilter": boolean, "proposeRestartIds": string[]}.',
              'intent: what the user is asking about. "attention" = what needs the instructor\'s attention. "selected_detail" = about the focused PC. Use "unknown" when unsure.',
              "Nothing you write is shown to the user: the server renders every reply from verified data. Any extra text fields you return are ignored.",
              'Vocabulary: "off" means deprovisioned - finished labs, switched off, no longer billing (totals.off). Failed environments are still ON and billing; they are broken, not off (totals.failed).',
              "proposeRestartIds: ids from failedEnvironments only, and only when the user discussed fixing or restarting without clearly commanding it; the server, not you, decides any execution. Otherwise [].",
              "suggestFilter: true only when the user asked to show/filter/highlight a subset.",
              "Facts for classification only:",
              factsJson(ctx),
            ].join("\n"),
          },
          { role: "user", content: message },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > 4096) return null;
    // Tolerate markdown-fenced JSON; any free-text fields inside are ignored.
    const cleaned = content.replace(/```(?:json)?/gi, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (!parsed || typeof parsed.intent !== "string" || !INTENT_SET.has(parsed.intent as Intent)) return null;
    const failedIds = new Set(ctx.failed.map((e) => e.id));
    const proposeRestartIds = Array.isArray(parsed.proposeRestartIds)
      ? [...new Set(parsed.proposeRestartIds.filter((v): v is string => typeof v === "string" && failedIds.has(v.toLowerCase())).map((v) => v.toLowerCase()))]
      : [];
    return {
      intent: parsed.intent as Intent,
      suggestFilter: parsed.suggestFilter === true,
      proposeRestartIds,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- suggested filters (deterministic intent mapping first) ----------

function suggestedFilterFor(message: string, wantsFilter: boolean): { filter: FilterQuery; description: string[] } | null {
  if (!wantsFilter) return null;
  // Deterministic intent mapping first: a chat request like "show the failed
  // ones" contains words ("pcs", "off") the strict filter compiler refuses,
  // but the intent is unambiguous here. OFF maps to deprovisioned, never to
  // failed.
  let filter: FilterQuery | null = null;
  if (OFF_RE.test(message) && !FAILED_WORDS_RE.test(message)) filter = { states: ["deprovisioned"], sort: "risk" };
  else if (FAILED_WORDS_RE.test(message)) filter = { states: ["failed"], sort: "risk" };
  else if (/\bstuck|frozen|same step|stall\b/i.test(message)) filter = { stuck: true, sort: "risk" };
  if (!filter) {
    const { result } = analyzeNL(message);
    if (result.ok && result.filter && Object.keys(result.filter).length) filter = result.filter;
  }
  if (!filter) return null;
  return { filter, description: describeFilter(filter) };
}

// ---------- orchestration ----------

export async function handleAgent(req: AgentRequest, demoId: string | null): Promise<AgentResponse> {
  const now = Date.now();
  let snapshot = await getSnapshot(now, demoId);
  let ctx = buildContext(snapshot, req.selectedId);
  // The log length before this request - the honest "stateVersion" even when
  // executions below refresh the context afterwards.
  const stateVersionBefore = snapshot.stateVersion;

  const respond = (partial: {
    reply: string;
    source: "llm" | "local";
    degraded: boolean;
    suggestedFilter?: { filter: FilterQuery; description: string[] } | null;
    proposedActions?: AgentProposedAction[];
    executedActions?: AgentExecutedAction[];
    actionsAppended?: { id: string; at: number }[];
  }): AgentResponse => {
    const appended = partial.actionsAppended ?? [];
    return {
      ok: true,
      reply: partial.reply,
      source: partial.source,
      degraded: partial.degraded,
      now,
      stateVersion: stateVersionBefore,
      // After executions the context was refreshed from the store, so this is
      // the actual post-append log length - never before + own count.
      stateVersionAfter: ctx.stateVersion,
      summary: ctx.summary,
      selected: ctx.selected ? enrich(ctx.selected, now) : null,
      suggestedFilter: partial.suggestedFilter ?? null,
      proposedActions: partial.proposedActions ?? [],
      executedActions: partial.executedActions ?? [],
      actionsAppended: appended,
      refreshRequired: appended.length > 0,
    };
  };

  // 1. Confirmed execution: no provider call, server revalidates everything.
  if (req.confirm) {
    const { executed, appended } = await executeReprovisions(req.confirm.ids, snapshot.environments, now, demoId);
    if (appended.length) {
      snapshot = await getSnapshot(Date.now(), demoId);
      ctx = buildContext(snapshot, req.selectedId);
    }
    return respond({ reply: executionReply(executed), source: "local", degraded: false, executedActions: executed, actionsAppended: appended });
  }

  const message = req.message!;

  // 2. Negated directive: acknowledge, never act.
  if (DIRECTIVE_RE.test(message) && NEGATED_RE.test(message)) {
    return respond({
      reply: "Understood - I won't restart anything. Nothing has changed. Ask if you'd like the current state of any PC instead.",
      source: "local",
      degraded: false,
    });
  }

  // 3. Unambiguous directive in the user's own words: resolve targets, execute.
  if (looksLikeDirective(message)) {
    const targets = resolveTargets(message, ctx, req.selectedId, snapshot.environments);
    if (targets.kind === "ambiguous") {
      return respond({ reply: `Which PC should I restart? ${targets.reason}.`, source: "local", degraded: false });
    }
    if (targets.kind === "none" || targets.ids.length === 0) {
      const noneFailed = ctx.failed.length === 0;
      const offAsked = OFF_RE.test(message) && ctx.summary.byState.deprovisioned === 0;
      return respond({
        reply: offAsked
          ? "No PCs are off right now - every lab is still running. Off means finished (deprovisioned), and only failed environments can be restarted."
          : noneFailed
            ? "There are no failed environments to restart right now - nothing to fix."
            : "I couldn't tell which PC you mean. Select one in the room, name it, or say \"restart the failed ones\".",
        source: "local",
        degraded: false,
      });
    }
    const restartable = targets.ids.filter((id) => ctx.failed.some((e) => e.id === id));
    const notFailed = targets.ids.filter((id) => !restartable.includes(id));
    if (!restartable.length) {
      let what: string;
      if (notFailed.length <= 3) {
        what = notFailed.map((id) => {
          const e = snapshot.environments.find((x) => x.id === id);
          return e ? `${id} is ${e.state.replace("_", " ")}` : `${id} is unknown`;
        }).join(", ");
      } else {
        const counts = new Map<string, number>();
        for (const id of notFailed) {
          const e = snapshot.environments.find((x) => x.id === id);
          const st = e ? e.state.replace("_", " ") : "unknown";
          counts.set(st, (counts.get(st) ?? 0) + 1);
        }
        what = [...counts.entries()].map(([st, n]) => `${n} are ${st}`).join(", ");
      }
      const includesOff = notFailed.some((id) => snapshot.environments.find((x) => x.id === id)?.state === "deprovisioned");
      return respond({
        reply: `Nothing to restart: ${what}. Only failed environments can be restarted - stuck or slow ones usually recover on their own.${includesOff ? " Off PCs are finished labs, not broken ones; the simulation has no operation to switch them back on." : ""}`,
        source: "local",
        degraded: false,
      });
    }
    const { executed, appended } = await executeReprovisions(restartable, snapshot.environments, now, demoId);
    if (appended.length) {
      snapshot = await getSnapshot(Date.now(), demoId);
      ctx = buildContext(snapshot, req.selectedId);
    }
    let reply = executionReply(executed);
    if (notFailed.length) {
      reply += ` Not restarted (not failed): ${notFailed.join(", ")}.`;
    }
    // Mixed-scope directives: off PCs are never restartable - disclose the
    // exclusion instead of silently dropping that part of the request.
    const offExcluded = OFF_RE.test(message) ? ctx.summary.byState.deprovisioned : 0;
    if (offExcluded > 0) {
      reply += ` The ${offExcluded} off (finished) PC${offExcluded === 1 ? "" : "s"} can't be restarted - excluded, because off means deprovisioned and only failed environments can be restarted.`;
    }
    return respond({ reply, source: "local", degraded: false, executedActions: executed, actionsAppended: appended });
  }

  // 4. Question / conversation: deterministic renderers first; the model is
  //    consulted only when no intent matches, and then only to classify.
  const intent = localIntent(message, ctx);
  if (intent) {
    const r = renderIntent(intent, message, ctx);
    return respond({
      reply: r.reply,
      source: "local",
      degraded: false, // full-capability deterministic answer, labeled local
      suggestedFilter: suggestedFilterFor(message, r.wantsFilter),
    });
  }

  const provider = llmConfig();
  if (provider) {
    const answer = await tryLLM(message, ctx, provider);
    if (answer) {
      const rendered = renderIntent(answer.intent, message, ctx);
      const proposedActions: AgentProposedAction[] = answer.proposeRestartIds.length
        ? [{ kind: "reprovision", ids: answer.proposeRestartIds, label: `Restart ${answer.proposeRestartIds.length} failed environment${answer.proposeRestartIds.length === 1 ? "" : "s"}` }]
        : [];
      return respond({
        reply: rendered.reply,
        source: "llm",
        degraded: false,
        suggestedFilter: suggestedFilterFor(message, answer.suggestFilter),
        proposedActions,
      });
    }
  }

  const r = renderIntent("unknown", message, ctx);
  return respond({
    reply: r.reply,
    source: "local",
    degraded: true, // the question needed the model and it was unavailable
    suggestedFilter: null,
  });
}
