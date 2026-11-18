import { NextResponse } from "next/server";
import { getSnapshot, summarizeSnapshot } from "@/lib/store";
import { createDemoSession, DemoSessionError, PersistUnavailable } from "@/lib/persistence";
import { clientKey, rateLimitOk } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const snapshot = await getSnapshot(Date.now(), req.headers.get("x-demo-session"));
    return NextResponse.json(summarizeSnapshot(snapshot));
  } catch (err) {
    if (err instanceof DemoSessionError) return NextResponse.json({ error: err.code }, { status: err.status });
    if (err instanceof PersistUnavailable) {
      return NextResponse.json({ error: "persist_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "session_unavailable" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!rateLimitOk(`demo:${clientKey(req)}`, 12, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    return NextResponse.json(await createDemoSession(), { status: 201 });
  } catch {
    return NextResponse.json({ error: "persist_unavailable" }, { status: 503 });
  }
}
