/**
 * normalize.ts — turns a raw model response into a validated ReceiptRow.
 *
 * All business rules live here. The guiding principle: FLAG, NEVER SILENTLY
 * CORRECT. Bookkeepers do not trust software that edits their numbers, so when
 * something looks wrong we lower confidence and raise a flag for human review
 * rather than "fixing" the figure.
 */

import {
  CATEGORIES,
  ReceiptSchema,
  type Receipt,
  type ReceiptRow,
  type NormalizedLineItem,
} from "./schema";

/** Tolerance for the subtotal + tax + tip = total check. */
const ARITHMETIC_TOLERANCE = 0.02;

/**
 * Parse a money-ish value into a number.
 * Handles "$1,234.56", "1 234,56", "(12.34)" negatives, "12.34-" trailing minus.
 */
export function parseMoney(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? round2(input) : null;
  }
  if (typeof input !== "string") return null;

  let s = input.trim();
  if (!s) return null;

  // Accounting negatives: (12.34) and trailing minus 12.34-
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/-\s*$/.test(s)) {
    negative = true;
    s = s.replace(/-\s*$/, "");
  }
  if (/^\s*-/.test(s)) {
    negative = true;
  }

  // Strip everything that is not a digit, separator or sign.
  s = s.replace(/[^0-9.,-]/g, "");
  if (!s) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the rightmost one is the decimal separator.
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    // Only commas. "1,234" is a thousands separator; "12,34" is a decimal.
    const after = s.length - lastComma - 1;
    s = after === 3 && s.replace(/[^0-9]/g, "").length > 3
      ? s.replace(/,/g, "")
      : s.replace(",", ".");
  }

  s = s.replace(/-/g, "");
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return round2(negative ? -n : n);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Normalize a date to YYYY-MM-DD, or return null when unusable. */
export function parseDate(input: unknown): { value: string; flag: boolean } {
  if (typeof input !== "string" || !input.trim()) {
    return { value: "", flag: true };
  }
  const s = input.trim();

  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    y = +iso[1];
    m = +iso[2];
    d = +iso[3];
  } else {
    const slash = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (slash) {
      m = +slash[1];
      d = +slash[2];
      let yy = +slash[3];
      if (yy < 100) yy = yy <= 49 ? 2000 + yy : 1900 + yy;
      y = yy;
      // Impossible as MM/DD but valid as DD/MM: swap.
      if (m > 12 && d <= 12) {
        const t = m;
        m = d;
        d = t;
      }
    }
  }

  if (y === null || m === null || d === null) return { value: "", flag: true };
  if (m < 1 || m > 12 || d < 1 || d > 31) return { value: "", flag: true };

  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return { value: "", flag: true };
  }

  // Sanity window: reject future dates and anything before 2000.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (dt > tomorrow || y < 2000) {
    return { value: fmt(y, m, d), flag: true };
  }

  return { value: fmt(y, m, d), flag: false };
}

function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseTime(input: unknown): string {
  if (typeof input !== "string") return "";
  const m = input.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  let h = +m[1];
  const min = +m[2];
  if (/pm/i.test(input) && h < 12) h += 12;
  if (/am/i.test(input) && h === 12) h = 0;
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

function parseConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return 0.5;
  // Tolerate a model returning 85 instead of 0.85.
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, round2(scaled)));
}

function normalizeCurrency(v: unknown): string {
  const s = str(v).toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (s.includes("$")) return "USD";
  if (s.includes("€")) return "EUR";
  if (s.includes("£")) return "GBP";
  return "USD";
}

function normalizeCategory(v: unknown): string {
  const s = str(v);
  const hit = CATEGORIES.find((c) => c.toLowerCase() === s.toLowerCase());
  return hit ?? "Other";
}

/**
 * Validate and normalize one model response.
 * Throws only if the payload is not an object at all; otherwise always returns
 * a row, using flags to communicate problems.
 */
export function normalizeReceipt(raw: unknown, fileName: string): ReceiptRow {
  const parsed = ReceiptSchema.safeParse(raw);
  const r: Receipt = parsed.success ? parsed.data : {};

  const flags: string[] = [];
  if (!parsed.success) flags.push("schema");

  const merchant = str(r.merchant);
  if (!merchant) flags.push("merchant");

  const dateResult = parseDate(r.date);
  if (dateResult.flag) flags.push("date");

  const subtotal = parseMoney(r.subtotal);
  const tax = parseMoney(r.tax);
  const tip = parseMoney(r.tip);
  const total = parseMoney(r.total);

  // Total is required. A row without one is unusable for bookkeeping.
  if (total === null) flags.push("total");

  // Arithmetic sanity check. Flag only; never rewrite the figures.
  if (total !== null && subtotal !== null) {
    const sum = round2(subtotal + (tax ?? 0) + (tip ?? 0));
    if (Math.abs(sum - total) > ARITHMETIC_TOLERANCE) {
      flags.push("arithmetic");
    }
  }

  const line_items: NormalizedLineItem[] = (r.line_items ?? [])
    .filter((li): li is NonNullable<typeof li> => !!li)
    .map((li) => ({
      item_description: str(li.item_description),
      qty: parseMoney(li.qty),
      unit_price: parseMoney(li.unit_price),
      line_total: parseMoney(li.line_total),
    }))
    .filter(
      (li) =>
        li.item_description !== "" ||
        li.line_total !== null ||
        li.unit_price !== null,
    );

  // Line items should reconcile to the subtotal (or the total when no subtotal
  // is printed). A mismatch usually means the model confused a printed line
  // total with a unit price and multiplied by quantity. Flag rather than fix:
  // the flat CSV is still trustworthy, but the itemized export is not.
  const reconcileTarget = subtotal ?? total;
  if (line_items.length > 0 && reconcileTarget !== null) {
    const itemSum = round2(
      line_items.reduce((acc, li) => acc + (li.line_total ?? 0), 0),
    );
    // Tolerance scales with the receipt: a cent per item plus 1%, since
    // discounts and unlisted fees legitimately create small gaps.
    const tolerance = Math.max(
      0.02 * line_items.length,
      Math.abs(reconcileTarget) * 0.01,
    );
    if (itemSum > 0 && Math.abs(itemSum - reconcileTarget) > tolerance) {
      flags.push("line_items");
    }
  }

  // Confidence is computed LAST so that every flag raised above, including the
  // line-item reconciliation check, feeds into the cap.
  let confidence = parseConfidence(r.confidence);
  // Any structural flag caps confidence so the UI cannot show a reassuring
  // number on a row that failed validation.
  if (flags.length > 0) confidence = Math.min(confidence, 0.6);

  return {
    file_name: fileName,
    merchant,
    merchant_address: str(r.merchant_address),
    date: dateResult.value,
    time: parseTime(r.time),
    subtotal,
    tax,
    tip,
    total,
    currency: normalizeCurrency(r.currency),
    payment_method: str(r.payment_method),
    category: normalizeCategory(r.category),
    confidence,
    notes: "",
    flags,
    line_items,
  };
}

/** Human-readable explanation for a flag, shown on hover in the grid. */
export const FLAG_LABELS: Record<string, string> = {
  merchant: "Merchant name could not be read",
  date: "Date missing, unreadable or out of range",
  total: "Total could not be read — check this receipt",
  arithmetic: "Subtotal + tax + tip does not match the total",
  line_items: "Line items do not add up to the subtotal — check the itemized export",
  schema: "Model returned an unexpected shape",
  lowconfidence: "Model reported low confidence on this receipt",
};
