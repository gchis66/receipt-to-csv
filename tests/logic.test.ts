/**
 * Logic tests for normalize.ts and csv.ts. Run: node --experimental-strip-types tests/logic.test.ts
 * No test framework on purpose — this is a proposal MVP, and a dependency-free
 * assertion script is enough to prove the parsing rules hold.
 */

import assert from "node:assert";
import { parseMoney, parseDate, normalizeReceipt } from "../lib/normalize.ts";
import { toFlatCsv, toItemizedCsv } from "../lib/csv.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("\nparseMoney");
test("plain number", () => assert.equal(parseMoney(12.34), 12.34));
test("dollar sign and comma", () => assert.equal(parseMoney("$1,234.56"), 1234.56));
test("european decimal comma", () => assert.equal(parseMoney("1.234,56"), 1234.56));
test("bare decimal comma", () => assert.equal(parseMoney("12,34"), 12.34));
test("thousands comma no decimal", () => assert.equal(parseMoney("1,234"), 1234));
test("accounting negative parens", () => assert.equal(parseMoney("(12.34)"), -12.34));
test("trailing minus", () => assert.equal(parseMoney("12.34-"), -12.34));
test("currency word suffix", () => assert.equal(parseMoney("45.00 USD"), 45));
test("euro symbol", () => assert.equal(parseMoney("€9,99"), 9.99));
test("null passthrough", () => assert.equal(parseMoney(null), null));
test("empty string", () => assert.equal(parseMoney(""), null));
test("garbage", () => assert.equal(parseMoney("N/A"), null));
test("rounds to 2dp", () => assert.equal(parseMoney(12.3456), 12.35));

console.log("\nparseDate");
test("iso passthrough", () => assert.equal(parseDate("2026-03-14").value, "2026-03-14"));
test("us slash", () => assert.equal(parseDate("03/14/2026").value, "2026-03-14"));
test("two digit year", () => assert.equal(parseDate("03/14/26").value, "2026-03-14"));
test("dd/mm swap when impossible as mm/dd", () =>
  assert.equal(parseDate("25/03/2026").value, "2026-03-25"));
test("dot separator", () => assert.equal(parseDate("14.03.2026").value, "2026-03-14"));
test("future date flagged", () => assert.equal(parseDate("01/01/2099").flag, true));
test("pre-2000 flagged", () => assert.equal(parseDate("01/01/1995").flag, true));
test("impossible month flagged", () => assert.equal(parseDate("13/45/2026").flag, true));
test("feb 30 rejected", () => assert.equal(parseDate("02/30/2026").flag, true));
test("missing flagged", () => assert.equal(parseDate(null).flag, true));

console.log("\nnormalizeReceipt");
test("clean receipt has no flags", () => {
  const row = normalizeReceipt(
    {
      merchant: "Blue Bottle Coffee",
      date: "2026-03-14",
      subtotal: 10.0,
      tax: 0.9,
      tip: 2.0,
      total: 12.9,
      currency: "USD",
      category: "Meals",
      confidence: 0.95,
      line_items: [
        { item_description: "Latte", qty: 2, unit_price: 5, line_total: 10 },
      ],
    },
    "cafe.jpg",
  );
  assert.deepEqual(row.flags, [], `unexpected flags: ${row.flags}`);
  assert.equal(row.total, 12.9);
  assert.equal(row.confidence, 0.95);
  assert.equal(row.line_items.length, 1);
});

test("arithmetic mismatch is flagged, figures untouched", () => {
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", subtotal: 10, tax: 1, tip: 0, total: 99, confidence: 0.99 },
    "f.jpg",
  );
  assert.ok(row.flags.includes("arithmetic"));
  assert.equal(row.total, 99, "total must NOT be silently corrected");
  assert.equal(row.subtotal, 10);
  assert.ok(row.confidence <= 0.6, "confidence must be capped when flagged");
});

test("penny rounding within tolerance is not flagged", () => {
  // Real receipts are often off by a cent from tax rounding. 10 + 1.01 = 11.01
  // printed as 11.02 must NOT be flagged, or every batch would look broken.
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", subtotal: 10, tax: 1.01, tip: 0, total: 11.02, confidence: 0.9 },
    "f.jpg",
  );
  assert.ok(!row.flags.includes("arithmetic"), `flags: ${row.flags}`);
  assert.equal(row.confidence, 0.9, "clean row keeps its confidence");
});

test("gap beyond tolerance is flagged", () => {
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", subtotal: 10, tax: 1.01, tip: 0, total: 12, confidence: 0.9 },
    "f.jpg",
  );
  assert.ok(row.flags.includes("arithmetic"), "99 cent gap must flag");
});

test("missing total flagged", () => {
  const row = normalizeReceipt({ merchant: "X", date: "2026-03-14", total: null }, "f.jpg");
  assert.ok(row.flags.includes("total"));
});

test("missing merchant flagged", () => {
  const row = normalizeReceipt({ merchant: null, date: "2026-03-14", total: 5 }, "f.jpg");
  assert.ok(row.flags.includes("merchant"));
});

test("confidence 85 treated as 0.85", () => {
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", total: 5, confidence: 85 },
    "f.jpg",
  );
  assert.equal(row.confidence, 0.85);
});

test("junk category falls back to Other", () => {
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", total: 5, category: "Spaceship", confidence: 0.9 },
    "f.jpg",
  );
  assert.equal(row.category, "Other");
});

test("currency symbol maps to code", () => {
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", total: 5, currency: "£", confidence: 0.9 },
    "f.jpg",
  );
  assert.equal(row.currency, "GBP");
});

test("empty object does not throw", () => {
  const row = normalizeReceipt({}, "blank.jpg");
  assert.ok(row.flags.includes("total"));
  assert.equal(row.file_name, "blank.jpg");
});

test("non-object does not throw", () => {
  const row = normalizeReceipt("not a receipt", "x.jpg");
  assert.ok(row.flags.length > 0);
});

test("line items that do not reconcile are flagged", () => {
  // The exact bug seen in live testing: "2 Cappuccino 9.00" returned as
  // unit_price 9 / line_total 18, inflating the item sum above the subtotal.
  const row = normalizeReceipt(
    {
      merchant: "X",
      date: "2026-03-14",
      subtotal: 26.25,
      tax: 2.49,
      tip: 5,
      total: 33.74,
      confidence: 0.95,
      line_items: [
        { item_description: "Cappuccino", qty: 2, unit_price: 9, line_total: 18 },
        { item_description: "Avocado Toast", qty: 1, unit_price: 12.5, line_total: 12.5 },
        { item_description: "Orange Juice", qty: 1, unit_price: 4.75, line_total: 4.75 },
      ],
    },
    "f.jpg",
  );
  assert.ok(row.flags.includes("line_items"), `flags: ${row.flags}`);
  assert.ok(row.confidence <= 0.6);
});

test("correctly reconciling line items are not flagged", () => {
  const row = normalizeReceipt(
    {
      merchant: "X",
      date: "2026-03-14",
      subtotal: 26.25,
      tax: 2.49,
      tip: 5,
      total: 33.74,
      confidence: 0.95,
      line_items: [
        { item_description: "Cappuccino", qty: 2, unit_price: 4.5, line_total: 9 },
        { item_description: "Avocado Toast", qty: 1, unit_price: 12.5, line_total: 12.5 },
        { item_description: "Orange Juice", qty: 1, unit_price: 4.75, line_total: 4.75 },
      ],
    },
    "f.jpg",
  );
  assert.ok(!row.flags.includes("line_items"), `flags: ${row.flags}`);
  assert.equal(row.confidence, 0.95);
});

test("small discount gap does not flag", () => {
  const row = normalizeReceipt(
    {
      merchant: "X",
      date: "2026-03-14",
      subtotal: 100,
      total: 100,
      confidence: 0.9,
      line_items: [
        { item_description: "A", qty: 1, unit_price: 50.5, line_total: 50.5 },
        { item_description: "B", qty: 1, unit_price: 50, line_total: 50 },
      ],
    },
    "f.jpg",
  );
  assert.ok(!row.flags.includes("line_items"), `flags: ${row.flags}`);
});

test("receipt with no line items is never line-flagged", () => {
  const row = normalizeReceipt(
    { merchant: "X", date: "2026-03-14", subtotal: 10, tax: 0, tip: 0, total: 10, confidence: 0.9 },
    "f.jpg",
  );
  assert.ok(!row.flags.includes("line_items"));
});

console.log("\ncsv");
const rows = [
  normalizeReceipt(
    {
      merchant: 'Joe "Big" Diner, Inc.',
      date: "2026-03-14",
      subtotal: 10,
      tax: 0.9,
      tip: 2,
      total: 12.9,
      currency: "USD",
      category: "Meals",
      confidence: 0.95,
      line_items: [{ item_description: "Burger, large", qty: 2, unit_price: 5, line_total: 10 }],
    },
    "a.jpg",
  ),
  normalizeReceipt(
    { merchant: "=cmd|calc", date: "2026-03-15", total: 7.5, confidence: 0.8 },
    "b.jpg",
  ),
];

test("quotes are doubled and field wrapped", () => {
  const csv = toFlatCsv(rows);
  assert.ok(csv.includes('"Joe ""Big"" Diner, Inc."'), csv.split("\r\n")[1]);
});

test("formula injection neutralized", () => {
  const csv = toFlatCsv(rows);
  assert.ok(csv.includes("'=cmd|calc"), "leading = must be escaped to text");
});

test("has BOM and CRLF", () => {
  const csv = toFlatCsv(rows);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("\r\n"));
});

test("header matches column count on every row", () => {
  const csv = toFlatCsv(rows).replace(/^\uFEFF/, "");
  const lines = csv.trim().split("\r\n");
  const count = (line: string) => {
    let n = 1;
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') i++;
        else inQ = !inQ;
      } else if (c === "," && !inQ) n++;
    }
    return n;
  };
  const expected = count(lines[0]);
  assert.equal(expected, 14, `expected 14 columns, got ${expected}`);
  for (const l of lines.slice(1)) {
    assert.equal(count(l), expected, `row column mismatch: ${l}`);
  }
});

test("money formatted to 2dp, nulls empty", () => {
  const csv = toFlatCsv(rows).replace(/^\uFEFF/, "");
  const second = csv.trim().split("\r\n")[2];
  assert.ok(second.includes("7.50"), second);
  assert.ok(second.includes(",,"), "null subtotal should be an empty field");
});

test("itemized csv only includes rows with items", () => {
  const csv = toItemizedCsv(rows).replace(/^\uFEFF/, "");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2, "1 header + 1 item row");
  assert.ok(lines[1].includes('"Burger, large"'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
