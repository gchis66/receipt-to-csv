import { NextResponse } from "next/server";
import { extractReceipt, ExtractionError } from "@/lib/extract";
import { normalizeReceipt } from "@/lib/normalize";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILES = 20;
const MAX_BYTES_PER_IMAGE = 8 * 1024 * 1024; // 8 MB after client downscaling
// Vercel caps serverless request bodies at 4.5MB. Reject slightly under that
// with a readable message; otherwise the platform returns an opaque
// FUNCTION_PAYLOAD_TOO_LARGE that no client can parse. The browser batches by
// size to stay below this, but direct API callers need a real error.
const MAX_TOTAL_PAYLOAD_BYTES = 4_000_000;

interface IncomingItem {
  fileName?: unknown;
  dataUrl?: unknown;
}

/**
 * POST /api/extract
 * Body: { items: [{ fileName, dataUrl }] }
 *
 * Images arrive as data URLs already downscaled by the browser, which keeps
 * the payload small and means no file ever touches disk on the server.
 * Receipts are financial documents; nothing is persisted anywhere.
 */
export async function POST(req: Request) {
  let payload: { items?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const items = Array.isArray(payload.items) ? payload.items : null;
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "No files submitted" }, { status: 400 });
  }
  if (items.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Please submit at most ${MAX_FILES} receipts at a time.` },
      { status: 400 },
    );
  }

  const limit = checkRateLimit(clientIp(req), items.length);
  if (!limit.ok) {
    return NextResponse.json(
      {
        error:
          "Demo limit reached for this hour. This cap exists to keep the public demo affordable.",
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // Validate before spending a single token.
  const jobs: { fileName: string; dataUrl: string }[] = [];
  let totalBytes = 0;
  for (const raw of items as IncomingItem[]) {
    const fileName = typeof raw?.fileName === "string" ? raw.fileName : "receipt";
    const dataUrl = typeof raw?.dataUrl === "string" ? raw.dataUrl : "";

    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(dataUrl)) {
      return NextResponse.json(
        { error: `Unsupported image data for "${fileName}".` },
        { status: 400 },
      );
    }
    const base64Length = dataUrl.length - dataUrl.indexOf(",") - 1;
    if (base64Length * 0.75 > MAX_BYTES_PER_IMAGE) {
      return NextResponse.json(
        { error: `"${fileName}" is too large after downscaling.` },
        { status: 413 },
      );
    }
    jobs.push({ fileName, dataUrl });
    totalBytes += dataUrl.length;
  }

  if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
    return NextResponse.json(
      {
        error:
          "This upload is too large for one request. Send fewer receipts per batch (the web app does this automatically).",
      },
      { status: 413 },
    );
  }

  // Bounded concurrency: fast for a batch, without tripping provider limits.
  const CONCURRENCY = 4;
  const results: (
    | { ok: true; row: ReturnType<typeof normalizeReceipt> }
    | { ok: false; fileName: string; error: string }
  )[] = new Array(jobs.length);

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      try {
        const raw = await extractReceipt(job.dataUrl);
        results[i] = { ok: true, row: normalizeReceipt(raw, job.fileName) };
      } catch (err) {
        const message =
          err instanceof ExtractionError
            ? err.message
            : "Unexpected error during extraction";
        results[i] = { ok: false, fileName: job.fileName, error: message };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker),
  );

  // Partial success is normal and must not fail the whole batch: one bad photo
  // in a batch of ten should not lose the other nine.
  return NextResponse.json({
    rows: results.filter((r) => r.ok).map((r) => (r as { row: unknown }).row),
    failures: results
      .filter((r) => !r.ok)
      .map((r) => {
        const f = r as { fileName: string; error: string };
        return { fileName: f.fileName, error: f.error };
      }),
  });
}
