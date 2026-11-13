import { toFlatCsv, toItemizedCsv } from "@/lib/csv";
import type { ReceiptRow } from "@/lib/schema";

export const runtime = "nodejs";

/**
 * POST /api/export
 * Body: { rows: ReceiptRow[], mode: "flat" | "itemized" }
 *
 * Serialization happens server-side so the CSV rules live in one place
 * (lib/csv.ts) and stay identical to whatever a future scheduled/API export
 * would produce.
 */
export async function POST(req: Request) {
  let payload: { rows?: unknown; mode?: unknown };
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const rows = Array.isArray(payload.rows) ? (payload.rows as ReceiptRow[]) : [];
  if (rows.length === 0) {
    return new Response("No rows to export", { status: 400 });
  }

  const mode = payload.mode === "itemized" ? "itemized" : "flat";
  const csv = mode === "itemized" ? toItemizedCsv(rows) : toFlatCsv(rows);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename =
    mode === "itemized"
      ? `receipts-line-items-${stamp}.csv`
      : `receipts-${stamp}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
