/**
 * Live accuracy regression test against the three real sample receipts.
 *
 * Requires: dev server on :3000 and a working OPENROUTER_API_KEY.
 * Run: node tests/accuracy.mjs
 *
 * This is the gate that matters before quoting an accuracy number to a client.
 * Ground truth below was read by hand from the photographs — do not "fix" these
 * numbers to make a model pass. If a model disagrees with them, the model is
 * wrong.
 *
 * Baseline (google/gemini-2.5-flash): 3/3 receipts, 15/15 fields, zero flags,
 * line items reconciling to subtotal on all three. Verified stable over 3
 * repeat runs (9/9).
 */
import { readFileSync, existsSync } from "node:fs";

const DIR = new URL("../public/samples/", import.meta.url).pathname;
const BASE = process.env.BASE_URL || "http://localhost:3000";

const TRUTH = {
  "sample-cafe.jpg": {
    label: "Chipotle — crumpled, photographed rotated 90°",
    merchant: /chipotle/i,
    date: "2026-07-23",
    subtotal: 14.6,
    tax: 1.02,
    total: 15.62,
  },
  "sample-thermal.jpg": {
    label: "Lester's Diner — thermal, heavy crease down the middle",
    merchant: /lester/i,
    date: "2026-07-22",
    subtotal: 25.97,
    tax: 1.82,
    total: 27.79,
  },
  "sample-invoice.jpg": {
    label: "Publix — long grocery receipt, 11 line items, rotated",
    merchant: /publix/i,
    date: "2026-07-22",
    subtotal: 68.69,
    tax: 1.43,
    total: 70.12,
  },
};

const missing = Object.keys(TRUTH).filter((f) => !existsSync(DIR + f));
if (missing.length) {
  console.error(`Missing sample files: ${missing.join(", ")}`);
  process.exit(1);
}

const items = Object.keys(TRUTH).map((f) => ({
  fileName: f,
  dataUrl: `data:image/jpeg;base64,${readFileSync(DIR + f).toString("base64")}`,
}));

const t0 = Date.now();

// One receipt per request. Vercel caps request bodies at 4.5MB and these are
// full-size phone photos (~2MB each), so batching them here would 413 against
// production. The browser downscales before upload; this test deliberately
// sends originals to exercise the harder path.
const rows = [];
const failures = [];
for (const item of items) {
  let r;
  try {
    r = await fetch(`${BASE}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [item] }),
    });
  } catch {
    console.error(`Could not reach ${BASE} — is the server running?`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`extract failed for ${item.fileName}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const j = await r.json();
  rows.push(...(j.rows ?? []));
  failures.push(...(j.failures ?? []));
}

const data = { rows, failures };
console.log(`extracted ${data.rows.length}/${items.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
if (data.failures?.length) {
  for (const f of data.failures) console.log(`  FAILURE ${f.fileName}: ${f.error}`);
}

let criticalPass = 0;
let fieldsPass = 0;
let fieldsTotal = 0;
let hardFail = false;

for (const [file, t] of Object.entries(TRUTH)) {
  const row = data.rows.find((r) => r.file_name === file);
  console.log(`${file}  (${t.label})`);
  if (!row) {
    console.log("  MISSING FROM RESULTS\n");
    fieldsTotal += 5;
    hardFail = true;
    continue;
  }

  const checks = {
    merchant: t.merchant.test(row.merchant ?? ""),
    date: row.date === t.date,
    subtotal: Math.abs((row.subtotal ?? -999) - t.subtotal) < 0.005,
    tax: Math.abs((row.tax ?? -999) - t.tax) < 0.005,
    total: Math.abs((row.total ?? -999) - t.total) < 0.005,
  };
  fieldsTotal += 5;
  fieldsPass += Object.values(checks).filter(Boolean).length;

  for (const [k, ok] of Object.entries(checks)) {
    const got = row[k];
    console.log(
      `  ${ok ? "ok  " : "BAD "} ${k.padEnd(9)} ${String(got).padEnd(24)}${ok ? "" : `expected ${t[k]}`}`,
    );
  }

  // merchant + date + total is the client-facing bar.
  if (checks.merchant && checks.date && checks.total) criticalPass++;
  if (!checks.total) hardFail = true; // a wrong total is disqualifying

  const itemSum = +row.line_items
    .reduce((a, li) => a + (li.line_total ?? 0), 0)
    .toFixed(2);
  const reconciles =
    row.line_items.length === 0 || Math.abs(itemSum - (row.subtotal ?? 0)) < 0.02;
  console.log(
    `  ${reconciles ? "ok  " : "BAD "} line items  ${row.line_items.length} items, sum ${itemSum} vs subtotal ${row.subtotal}`,
  );
  console.log(`       flags: ${JSON.stringify(row.flags)}  confidence: ${row.confidence}\n`);
}

console.log("=".repeat(60));
console.log(`merchant+date+total correct : ${criticalPass}/${Object.keys(TRUTH).length}`);
console.log(`all fields correct          : ${fieldsPass}/${fieldsTotal}`);

const ok = criticalPass === Object.keys(TRUTH).length && !hardFail;
console.log(ok ? "\nPASS — safe to demo" : "\nFAIL — do not quote accuracy to a client");
process.exit(ok ? 0 : 1);
