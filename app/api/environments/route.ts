import { NextRequest, NextResponse } from "next/server";
import { getSnapshot, summarizeSnapshot } from "@/lib/store";
import { applyFilter, isStuck, onStepMinutes, progressPct, spendUsd } from "@/lib/filters";
import { EnvState, FilterQuery, STATE_ORDER } from "@/lib/types";
import { DemoSessionError, PersistUnavailable } from "@/lib/persistence";

export const dynamic = "force-dynamic";

function parseQuery(req: NextRequest): FilterQuery {
  const p = req.nextUrl.searchParams;
  const fq: FilterQuery = {};
  const states = p.get("states");
  if (states) {
    const list = states.split(",").filter((s): s is EnvState => (STATE_ORDER as string[]).includes(s));
    if (list.length) fq.states = list;
  }
  const q = p.get("q");
  if (q) fq.q = q;
  const num = (k: string): number | undefined => {
    const v = p.get(k);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  fq.step = num("step");
  fq.minStepMinutes = num("minStepMinutes");
  fq.minProgressPct = num("minProgressPct");
  fq.maxProgressPct = num("maxProgressPct");
  fq.minSpend = num("minSpend");
  const flag = (k: string) => p.get(k) === "1" || p.get(k) === "true";
  if (flag("minStepMinutesExclusive")) fq.minStepMinutesExclusive = true;
  if (flag("minProgressExclusive")) fq.minProgressExclusive = true;
  if (flag("maxProgressExclusive")) fq.maxProgressExclusive = true;
  if (flag("minSpendExclusive")) fq.minSpendExclusive = true;
  if (flag("stuck")) fq.stuck = true;
  const sort = p.get("sort");
  if (sort === "risk" || sort === "name" || sort === "progress" || sort === "spend" || sort === "stepMinutes") fq.sort = sort;
  const order = p.get("order");
  if (order === "asc" || order === "desc") fq.order = order;
  return fq;
}

// Per-instance memory of the previous computed snapshot, used only to report
// which environments changed state between polls (the "live activity" feed).
// Cold instances start with an empty baseline and simply report no
// transitions on their first poll - honest, never fabricated.
const prevSnapshots = new Map<string | null, { now: number; states: Map<string, EnvState> }>();
const MAX_TRACKED_DEMOS = 128;

export async function GET(req: NextRequest) {
  try {
    // One computed snapshot per request, shared by rows and summary, so the
    // table and the aggregates can never disagree within a refresh.
    const demoId = req.headers.get("x-demo-session");
    const snapshot = await getSnapshot(Date.now(), demoId);
    const { now, environments: all } = snapshot;
    const fq = parseQuery(req);
    const filtered = applyFilter(all, fq, now);
    const summary = summarizeSnapshot(snapshot);

    // Full-cohort step distribution for the cohort heatmap: unaffected by
    // the table's filters, computed from the same snapshot.
    const totalSteps = all[0]?.totalSteps ?? 12;
    const steps = Array.from({ length: totalSteps }, (_, i) => ({ step: i + 1, count: 0, failed: 0, done: 0, stuck: 0, maxOnStep: 0 }));
    for (const e of all) {
      const b = steps[Math.min(Math.max(e.step, 1), totalSteps) - 1];
      b.count++;
      if (e.state === "failed") b.failed++;
      if (e.state === "deprovisioned") b.done++;
      if (isStuck(e, now)) b.stuck++;
      // Dwell heat tracks ACTIVE learners only: a failed environment dwells
      // by definition, and a completed one no longer burns time - including
      // either would paint every bar hot and say nothing.
      if (e.state !== "failed" && e.state !== "deprovisioned") {
        const m = onStepMinutes(e, now);
        if (m > b.maxOnStep) b.maxOnStep = Math.floor(m);
      }
    }

    // State transitions since this instance's previous snapshot.
    const transitions: { id: string; learnerName: string; to: EnvState; failureReason: string | null; at: number }[] = [];
    const previous = prevSnapshots.get(demoId);
    if (!previous || now >= previous.now) {
      if (previous) {
        for (const e of all) {
          const before = previous.states.get(e.id);
          if (before !== undefined && before !== e.state) {
            transitions.push({ id: e.id, learnerName: e.learnerName, to: e.state, failureReason: e.failureReason, at: now });
          }
        }
      }
      prevSnapshots.delete(demoId);
      prevSnapshots.set(demoId, { now, states: new Map(all.map((e) => [e.id, e.state])) });
      if (prevSnapshots.size > MAX_TRACKED_DEMOS + Number(prevSnapshots.has(null))) {
        const oldestDemo = [...prevSnapshots.keys()].find((key) => key !== null);
        if (oldestDemo) prevSnapshots.delete(oldestDemo);
      }
    }

    const enrich = (e: (typeof all)[number]) => ({
      ...e,
      spendUsd: Math.round(spendUsd(e) * 100) / 100,
      progressPct: progressPct(e),
      // Floor, never round up: a learner at 19.96 min is not yet stuck and
      // must not display as "20m".
      onStepMinutes: Math.floor(onStepMinutes(e, now) * 10) / 10,
      stuck: isStuck(e, now),
    });

    return NextResponse.json({
      now,
      total: all.length,
      filtered: filtered.length,
      filter: fq,
      summary,
      sessionMode: demoId === null ? "shared" : "demo",
      sessionExpiresAt: snapshot.sessionExpiresAt,
      steps,
      transitions: transitions.slice(0, 12),
      environments: filtered.map(enrich),
      // The floor map draws every seat and dims the ones the filter excludes,
      // so it needs the whole room from the same snapshot (opt-in).
      ...(req.nextUrl.searchParams.get("include") === "all" ? { everyone: all.map(enrich) } : {}),
    });
  } catch (err) {
    if (err instanceof DemoSessionError) return NextResponse.json({ error: err.code }, { status: err.status });
    // A cold instance that cannot read the store must fail visibly instead
    // of resetting to the seed as if no actions had ever happened.
    if (err instanceof PersistUnavailable) {
      return NextResponse.json({ error: "persist_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "environments_unavailable" }, { status: 500 });
  }
}
