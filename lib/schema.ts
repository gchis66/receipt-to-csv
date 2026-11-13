/**
 * schema.ts — SINGLE SOURCE OF TRUTH for extraction shape.
 *
 * This is the primary file to edit when re-skinning for another client.
 * The zod schema drives:
 *   1. the JSON Schema sent to the vision model (structured output)
 *   2. server-side validation of the model response
 *   3. the CSV column order and headers
 *   4. the review-grid columns in the UI
 *
 * Change it here and the whole app follows.
 */

import { z } from "zod";

export const CATEGORIES = [
  "Meals",
  "Travel",
  "Fuel",
  "Lodging",
  "Office",
  "Software",
  "Other",
] as const;

/** Money arrives from the model as a number or a string like "$1,234.56". */
const money = z.union([z.number(), z.string()]).nullable().optional();

export const LineItemSchema = z.object({
  item_description: z.string().nullable().optional(),
  qty: z.union([z.number(), z.string()]).nullable().optional(),
  unit_price: money,
  line_total: money,
});

export const ReceiptSchema = z.object({
  merchant: z.string().nullable().optional(),
  merchant_address: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  time: z.string().nullable().optional(),
  subtotal: money,
  tax: money,
  tip: money,
  total: money,
  currency: z.string().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  confidence: z.union([z.number(), z.string()]).nullable().optional(),
  line_items: z.array(LineItemSchema).nullable().optional(),
});

export type Receipt = z.infer<typeof ReceiptSchema>;
export type LineItem = z.infer<typeof LineItemSchema>;

/** A validated, normalized row ready for the grid and the CSV. */
export interface ReceiptRow {
  file_name: string;
  merchant: string;
  merchant_address: string;
  date: string;
  time: string;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  currency: string;
  payment_method: string;
  category: string;
  confidence: number;
  notes: string;
  /** Field names the user should eyeball. Drives amber highlighting. */
  flags: string[];
  line_items: NormalizedLineItem[];
}

export interface NormalizedLineItem {
  item_description: string;
  qty: number | null;
  unit_price: number | null;
  line_total: number | null;
}

/** Flat CSV: column key -> header label. Order here is order in the file. */
export const FLAT_COLUMNS: { key: keyof ReceiptRow; label: string }[] = [
  { key: "file_name", label: "File Name" },
  { key: "merchant", label: "Merchant" },
  { key: "merchant_address", label: "Merchant Address" },
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "subtotal", label: "Subtotal" },
  { key: "tax", label: "Tax" },
  { key: "tip", label: "Tip" },
  { key: "total", label: "Total" },
  { key: "currency", label: "Currency" },
  { key: "payment_method", label: "Payment Method" },
  { key: "category", label: "Category" },
  { key: "confidence", label: "Confidence" },
  { key: "notes", label: "Notes" },
];

/** Itemized CSV headers, in order. */
export const ITEM_COLUMNS = [
  "File Name",
  "Merchant",
  "Date",
  "Item Description",
  "Qty",
  "Unit Price",
  "Line Total",
  "Currency",
] as const;

/**
 * JSON Schema handed to the model. Written by hand rather than generated so
 * the descriptions can carry extraction instructions — the field descriptions
 * do real prompt work and materially improve accuracy.
 */
export const RECEIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "merchant",
    "merchant_address",
    "date",
    "time",
    "subtotal",
    "tax",
    "tip",
    "total",
    "currency",
    "payment_method",
    "category",
    "confidence",
    "line_items",
  ],
  properties: {
    merchant: {
      type: ["string", "null"],
      description:
        "Business name exactly as printed at the top of the receipt. Not the parent company, not the street address.",
    },
    merchant_address: {
      type: ["string", "null"],
      description: "Street address on the receipt, single line. Null if absent.",
    },
    date: {
      type: ["string", "null"],
      description:
        "Transaction date normalized to YYYY-MM-DD. If the printed format is ambiguous between MM/DD and DD/MM, assume US MM/DD order. Null if no date is visible.",
    },
    time: {
      type: ["string", "null"],
      description: "Transaction time as 24-hour HH:MM. Null if absent.",
    },
    subtotal: {
      type: ["number", "null"],
      description: "Pre-tax subtotal as a plain number, no currency symbol.",
    },
    tax: {
      type: ["number", "null"],
      description: "Total tax as a plain number. Sum all tax lines if several.",
    },
    tip: {
      type: ["number", "null"],
      description:
        "Gratuity as a plain number, including handwritten tips. Null if none.",
    },
    total: {
      type: ["number", "null"],
      description:
        "Final amount charged as a plain number. If a handwritten total differs from the printed total, prefer the handwritten one and lower confidence.",
    },
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 code, e.g. USD, EUR, GBP. Default USD if unclear.",
    },
    payment_method: {
      type: ["string", "null"],
      description:
        "Payment method with masked digits if shown, e.g. 'VISA ***1234' or 'CASH'.",
    },
    category: {
      // NOTE: enum must NOT include null, and the type must be a bare "string".
      // Anthropic rejects `type: ["string","null"]` combined with an enum
      // ("Enum value 'Meals' does not match declared type"), while OpenAI
      // tolerates it. Keeping this a plain enum'd string is what makes the
      // schema portable across providers. normalizeCategory() already falls
      // back to "Other", so nothing depends on null being allowed here.
      type: "string",
      enum: [...CATEGORIES],
      description: "Best-fit expense category from the allowed list. Use Other if unsure.",
    },
    confidence: {
      type: ["number", "null"],
      description:
        "Your confidence from 0 to 1 that merchant, date and total are all correct. Be honest: use below 0.7 for blurry, faded, cropped or partially illegible receipts.",
    },
    line_items: {
      type: ["array", "null"],
      description:
        "Individual purchased items. Empty array if the receipt shows no itemization.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item_description", "qty", "unit_price", "line_total"],
        properties: {
          item_description: { type: ["string", "null"] },
          qty: { type: ["number", "null"] },
          unit_price: {
            type: ["number", "null"],
            description:
              "Price for ONE unit. Null if not separately printed and not confidently derivable. Do not copy the line total here.",
          },
          line_total: {
            type: ["number", "null"],
            description:
              "The money figure actually printed on this item's row — the total for the line including quantity. Never the printed figure multiplied by quantity.",
          },
        },
      },
    },
  },
} as const;
