import { NextResponse } from "next/server";
import { reprovision } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const updated = reprovision(id);
  if (!updated) {
    return NextResponse.json({ error: "not_found", detail: `No environment ${id}` }, { status: 404 });
  }
  return NextResponse.json({ ok: true, environment: updated });
}
