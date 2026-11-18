import { NextResponse } from "next/server";
import { getSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getSummary());
  } catch (err) {
    if (err instanceof Error && err.name === "PersistUnavailable") {
      return NextResponse.json({ error: "persist_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: "session_unavailable" }, { status: 500 });
  }
}
