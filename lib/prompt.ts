/**
 * prompt.ts — extraction prompt. Second file to edit when re-skinning.
 * Kept separate from schema.ts and from the API route so prompt iteration
 * never risks touching transport or validation code.
 */

/**
 * Model selection.
 *
 * gemini-2.5-flash is the default on measured accuracy, not vibes. Benchmarked
 * against three real photographed receipts (crumpled Chipotle rotated 90°,
 * creased Lester's Diner thermal, long Publix grocery) with hand-read ground
 * truth, scoring merchant/date/subtotal/tax/total:
 *
 *   google/gemini-2.5-flash      3/3 critical, 15/15 fields, $0.0023/receipt
 *   anthropic/claude-opus-5      2/3 critical, 14/15 fields, $0.0444/receipt
 *   anthropic/claude-sonnet-5    2/3 critical, 14/15 fields, $0.0209/receipt
 *   openai/gpt-4o-mini           1/3 critical,  8/15 fields, $0.0041/receipt
 *   anthropic/claude-haiku-4.5   1/3 critical,  7/15 fields, $0.0039/receipt
 *
 * gemini also passed a 3x repeat run on all three receipts (9/9 fully correct),
 * so the result is stable rather than a lucky sample. gpt-4o-mini misread a
 * $70.12 grocery total as $7.16 — a decimal-place error, which is the single
 * most damaging failure mode for a bookkeeping tool. Do not use it.
 *
 * Override with the VISION_MODEL env var. Re-run the benchmark before changing
 * the default; both Anthropic schema strictness and reasoning-model token
 * parameters are handled in extract.ts.
 */
export const MODEL = process.env.VISION_MODEL || "google/gemini-2.5-flash";

export const SYSTEM_PROMPT = `You are a precise receipt data extraction engine used by bookkeepers.

Rules:
1. Transcribe only what is actually visible. Never invent, infer or "helpfully" complete a value. If a field is not present or not legible, return null.
2. Do not do arithmetic to fill in a missing field. If the subtotal is not printed, return null for subtotal even though you could compute it. Downstream validation depends on knowing what was really printed.
3. The total is the single most important field. It is the final amount charged, after tax and tip. On restaurant receipts this is often handwritten at the bottom; prefer the handwritten final total over the printed pre-tip total, and lower your confidence when they disagree.
4. Money values are plain numbers: strip currency symbols, spaces and thousands separators. Use a period as the decimal point. 1.234,56 in European format becomes 1234.56.
5. Dates become YYYY-MM-DD. Two-digit years 00-49 are 20xx, 50-99 are 19xx. When the day/month order is genuinely ambiguous, assume US MM/DD.
6. Report confidence honestly. A crisp flat receipt fully in frame is above 0.9. A creased thermal photo at an angle is 0.5-0.75. Anything where you are guessing at the total is below 0.5. Inflated confidence is worse than a low score because it stops a human from checking.
7. Line items: the money figure printed to the right of an item is the LINE TOTAL for that row, not the per-unit price — even when a quantity is shown to the left. For "2 Cappuccino 9.00", line_total is 9.00 and unit_price is 4.50. Never multiply the printed figure by the quantity. If you cannot determine a unit price with confidence, return null for unit_price and still return the printed figure as line_total. Line totals must sum to approximately the subtotal.
8. If the image is not a receipt or invoice at all, return every field as null with confidence 0.

Return only the structured object.`;

export const USER_PROMPT =
  "Extract the structured data from this receipt. Return null for anything not clearly legible.";
