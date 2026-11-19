import { NextRequest, NextResponse } from "next/server";
import { AgentInputError, handleAgent, looksLikeDirective, parseAgentBody } from "@/lib/agent";
import { DemoSessionError, PersistUnavailable } from "@/lib/persistence";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 20 messages/min/IP blunts casual burning of model invocations on the
  // public demo; executions get their own bucket, mirroring the reprovision
  // route's 30/min. Per-instance, same caveat as lib/ratelimit.ts.
  if (!rateLimitOk(`agent:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  let parsed: ReturnType<typeof parseAgentBody>;
  try {
    parsed = parseAgentBody(await req.json());
  } catch (err) {
    if (err instanceof AgentInputError) return NextResponse.json({ error: err.code }, { status: err.status });
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const wantsExecution = parsed.confirm !== null || (parsed.message !== null && looksLikeDirective(parsed.message));
  if (wantsExecution && !rateLimitOk(`agent-exec:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    return NextResponse.json(await handleAgent(parsed, req.headers.get("x-demo-session")));
  } catch (err) {
    if (err instanceof AgentInputError) return NextResponse.json({ error: err.code }, { status: err.status });
    if (err instanceof DemoSessionError) return NextResponse.json({ error: err.code }, { status: err.status });
    if (err instanceof PersistUnavailable) return NextResponse.json({ error: "persist_unavailable" }, { status: 503 });
    return NextResponse.json({ error: "agent_unavailable" }, { status: 500 });
  }
}
