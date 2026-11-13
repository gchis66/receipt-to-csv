/**
 * csv.ts — RFC 4180 serialization.
 *
 * Hand-rolled rather than pulled from a dependency: the rules are short, and
 * the two things that actually matter (quote escaping and Excel's formula
 * injection quirk) are both handled explicitly below.
 */

import {
  FLAT_COLUMNS,
  ITEM_COLUMNS,
  type ReceiptRow,
} from "./schema";

/**
 * Escape one field per RFC 4180.
 * Also neutralizes leading =, +, -, @ which Excel and Sheets would otherwise
 * evaluate as a formula. A merchant literally named "=Dave's" is rare but a
 * CSV that executes on open is a real security problem, so prefix a
 * single quote to force text.
 */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function money(v: number | null): string {
  return v === null ? "" : v.toFixed(2);
}

function serializeRows(rows: string[][]): string {
  // CRLF line endings per RFC 4180; Excel on Windows is happiest with them.
  // Leading BOM so Excel reads UTF-8 merchant names correctly.
  return "\uFEFF" + rows.map((r) => r.join(",")).join("\r\n") + "\r\n";
}

/** Flat CSV — one row per receipt. */
export function toFlatCsv(rows: ReceiptRow[]): string {
  const out: string[][] = [FLAT_COLUMNS.map((c) => escapeField(c.label))];

  for (const row of rows) {
    out.push(
      FLAT_COLUMNS.map((c) => {
        const v = row[c.key];
        if (c.key === "subtotal" || c.key === "tax" || c.key === "tip" || c.key === "total") {
          return escapeField(money(v as number | null));
        }
        if (c.key === "confidence") {
          return escapeField((v as number).toFixed(2));
        }
        return escapeField(v);
      }),
    );
  }

  return serializeRows(out);
}

/** Itemized CSV — one row per line item. Receipts with no items are skipped. */
export function toItemizedCsv(rows: ReceiptRow[]): string {
  const out: string[][] = [ITEM_COLUMNS.map((c) => escapeField(c))];

  for (const row of rows) {
    for (const li of row.line_items) {
      out.push([
        escapeField(row.file_name),
        escapeField(row.merchant),
        escapeField(row.date),
        escapeField(li.item_description),
        escapeField(li.qty === null ? "" : String(li.qty)),
        escapeField(money(li.unit_price)),
        escapeField(money(li.line_total)),
        escapeField(row.currency),
      ]);
    }
  }

  return serializeRows(out);
}
