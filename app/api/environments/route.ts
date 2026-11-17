import { NextRequest, NextResponse } from "next/server";
import { getEnvironments } from "@/lib/store";
import { applyFilter, isStuck, onStepMinutes, progressPct, spendUsd } from "@/lib/filters";
import { EnvState, FilterQuery, STATE_ORDER } from "@/lib/types";

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
  if (p.get("stuck") === "1" || p.get("stuck") === "true") fq.stuck = true;
  const sort = p.get("sort");
  if (sort === "risk" || sort === "name" || sort === "progress" || sort === "spend" || sort === "stepMinutes") fq.sort = sort;
  const order = p.get("order");
  if (order === "asc" || order === "desc") fq.order = order;
  return fq;
}

export async function GET(req: NextRequest) {
  try {
    const now = Date.now();
    const all = getEnvironments();
    const fq = parseQuery(req);
    const filtered = applyFilter(all, fq, now);
    return NextResponse.json({
      now,
      total: all.length,
      filtered: filtered.length,
      filter: fq,
      environments: filtered.map((e) => ({
        ...e,
        spendUsd: Math.round(spendUsd(e) * 100) / 100,
        progressPct: progressPct(e),
        onStepMinutes: Math.round(onStepMinutes(e, now) * 10) / 10,
        stuck: isStuck(e, now),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "environments_unavailable", detail: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
