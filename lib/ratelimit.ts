/**
 * ratelimit.ts — in-memory IP rate limiter.
 *
 * The demo URL is public and every extraction costs money against Greg's
 * OpenRouter credit, so this is a spend guard, not a security control.
 * In-memory means it resets on cold start and is per-instance; that is an
 * accepted MVP tradeoff. A production build would use Upstash Redis.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_RECEIPTS_PER_WINDOW = 40;

const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  ip: string,
  cost: number,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  const existing = buckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    buckets.set(ip, { count: cost, resetAt: now + WINDOW_MS });
    return { ok: true };
  }

  if (existing.count + cost > MAX_RECEIPTS_PER_WINDOW) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += cost;
  return { ok: true };
}

/** Best-effort client IP from proxy headers. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
