import { NextResponse } from "next/server";
import { getSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getSummary());
  } catch (err) {
    return NextResponse.json(
      { error: "session_unavailable", detail: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
