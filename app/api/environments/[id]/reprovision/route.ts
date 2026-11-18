import { NextResponse } from "next/server";
import { reprovision } from "@/lib/store";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";
import { DemoSessionError } from "@/lib/persistence";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The demo is public; blunt scripted resets of the fake labs.
  if (!rateLimitOk(`reprov:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { id } = await ctx.params;
  try {
    const updated = await reprovision(id, Date.now(), req.headers.get("x-demo-session"));
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, environment: updated });
  } catch (err) {
    if (err instanceof DemoSessionError) return NextResponse.json({ error: err.code }, { status: err.status });
    const msg = err instanceof Error && err.message === "persist_failed" ? "persist_failed" : "persist_unavailable";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
