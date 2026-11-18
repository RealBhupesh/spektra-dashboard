// Best-effort per-IP token bucket for the mutation and NL endpoints. The demo
// is deliberately public, so this blunts casual abuse (a scripted loop burning
// model invocations or resetting the fake labs); it is per-instance on
// serverless and not a substitute for real auth, which DECISIONS.md lists as
// the next step.
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export function rateLimitOk(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (b.count >= limit) return false;
  b.count++;
  // Occasional sweep so the map does not grow forever.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }
  return true;
}

export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff?.split(",")[0] ?? "local").trim() || "local";
}
