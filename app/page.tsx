"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { prepareFiles, type PreparedFile } from "@/lib/prepare";
import { FLAG_LABELS } from "@/lib/normalize";
import { CATEGORIES, type ReceiptRow } from "@/lib/schema";

type Stage = "idle" | "preparing" | "extracting" | "done";

interface Failure {
  fileName: string;
  error: string;
}

const SAMPLES = [
  { file: "sample-cafe.jpg", label: "Restaurant receipt (crumpled, rotated)" },
  { file: "sample-thermal.jpg", label: "Diner receipt (thermal, creased)" },
  { file: "sample-invoice.jpg", label: "Grocery receipt (long, itemized)" },
];

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = stage === "preparing" || stage === "extracting";

  const flaggedCount = useMemo(
    () => rows.filter((r) => r.flags.length > 0 || r.confidence < 0.7).length,
    [rows],
  );
  const totalSum = useMemo(
    () => rows.reduce((acc, r) => acc + (r.total ?? 0), 0),
    [rows],
  );
  const hasLineItems = useMemo(
    () => rows.some((r) => r.line_items.length > 0),
    [rows],
  );

  const runExtraction = useCallback(async (prepared: PreparedFile[]) => {
    if (prepared.length === 0) return;
    setStage("extracting");
    setProgress({ done: 0, total: prepared.length });

    // Batch by PAYLOAD SIZE, not by a fixed count.
    //
    // Vercel caps serverless request bodies at 4.5MB. A fixed chunk of 4 large
    // phone photos can exceed that and return an opaque
    // FUNCTION_PAYLOAD_TOO_LARGE (413) which is not a JSON error the UI can
    // read. Cap each request well under the limit and also cap the item count
    // so no single request risks the function timeout.
    const MAX_BATCH_BYTES = 3_000_000; // ~3MB, safely under Vercel's 4.5MB
    const MAX_BATCH_ITEMS = 4;

    const batches: PreparedFile[][] = [];
    let current: PreparedFile[] = [];
    let currentBytes = 0;
    for (const p of prepared) {
      const size = p.dataUrl.length;
      const wouldExceed =
        current.length > 0 &&
        (currentBytes + size > MAX_BATCH_BYTES || current.length >= MAX_BATCH_ITEMS);
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(p);
      currentBytes += size;
    }
    if (current.length > 0) batches.push(current);

    const collected: ReceiptRow[] = [];
    const collectedFailures: Failure[] = [];
    let done = 0;

    for (const chunk of batches) {
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: chunk.map((p) => ({
              fileName: p.fileName,
              dataUrl: p.dataUrl,
            })),
          }),
        });

        if (!res.ok) {
          // A 413 from the platform is HTML/plain text, not our JSON shape.
          if (res.status === 413) {
            throw new Error(
              "These images are too large for one upload. Try fewer receipts at a time.",
            );
          }
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ||
              `Extraction failed with status ${res.status}`,
          );
        }

        const data = (await res.json()) as {
          rows: ReceiptRow[];
          failures: Failure[];
        };
        collected.push(...data.rows);
        collectedFailures.push(...(data.failures ?? []));
      } catch (err) {
        // A failed chunk must not discard successful chunks.
        for (const c of chunk) {
          collectedFailures.push({
            fileName: c.fileName,
            error: err instanceof Error ? err.message : "Request failed",
          });
        }
      }
      done += chunk.length;
      setProgress({ done, total: prepared.length });
      setRows([...collected]);
      setFailures([...collectedFailures]);
    }

    setStage("done");
  }, []);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      setError("");
      setFailures([]);
      setRows([]);
      setStage("preparing");

      if (files.length > 20) {
        setError("This demo handles up to 20 receipts at a time.");
        setStage("idle");
        return;
      }

      const { prepared, errors } = await prepareFiles(files);
      if (errors.length > 0) setFailures(errors);
      if (prepared.length === 0) {
        setError("None of those files could be read as receipts.");
        setStage("idle");
        return;
      }
      await runExtraction(prepared);
    },
    [runExtraction],
  );

  const loadSamples = useCallback(async () => {
    setError("");
    setFailures([]);
    setRows([]);
    setStage("preparing");
    try {
      const files = await Promise.all(
        SAMPLES.map(async (s) => {
          const res = await fetch(`/samples/${s.file}`);
          if (!res.ok) throw new Error(`Missing sample ${s.file}`);
          const blob = await res.blob();
          return new File([blob], s.file, { type: blob.type });
        }),
      );
      const { prepared, errors } = await prepareFiles(files);
      if (errors.length) setFailures(errors);
      await runExtraction(prepared);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the sample receipts.",
      );
      setStage("idle");
    }
  }, [runExtraction]);

  const updateCell = useCallback(
    (index: number, key: keyof ReceiptRow, value: string) => {
      setRows((prev) => {
        const next = [...prev];
        const row = { ...next[index] };
        if (
          key === "subtotal" ||
          key === "tax" ||
          key === "tip" ||
          key === "total"
        ) {
          const n = value.trim() === "" ? null : Number.parseFloat(value);
          (row[key] as number | null) = Number.isFinite(n as number)
            ? (n as number)
            : null;
        } else {
          (row[key] as string) = value;
        }
        // A human edit is authoritative: clear the flag for the edited field.
        row.flags = row.flags.filter((f) => f !== key);
        next[index] = row;
        return next;
      });
    },
    [],
  );

  const removeRow = useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const download = useCallback(
    async (mode: "flat" | "itemized") => {
      if (rows.length === 0) return;
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, mode }),
      });
      if (!res.ok) {
        setError("Export failed. Please try again.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        mode === "itemized" ? "receipts-line-items.csv" : "receipts.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [rows],
  );

  const reset = useCallback(() => {
    setRows([]);
    setFailures([]);
    setError("");
    setStage("idle");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          Receipt → CSV
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Drop in receipt photos or PDFs. Every field is extracted, validated and
          shown for review before you export. Files are processed in memory and
          never stored.
        </p>
      </header>

      {/* Upload zone */}
      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (!busy) void handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed bg-white p-10 text-center transition ${
          dragActive ? "border-blue-500 bg-blue-50" : "border-slate-300"
        } ${busy ? "opacity-60" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,.heic,.heif"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            // Reset so selecting the same file again still fires onChange.
            e.target.value = "";
          }}
        />
        <p className="text-base font-medium">
          Drag receipts here, or{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="text-blue-600 underline underline-offset-2 disabled:opacity-50"
          >
            browse files
          </button>
        </p>
        <p className="mt-1 text-xs text-muted">
          JPG, PNG, WEBP, HEIC or PDF · up to 20 at a time
        </p>

        <div className="mt-5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadSamples()}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Try 3 sample receipts
          </button>
        </div>
      </section>

      {/* Status */}
      {stage === "preparing" && (
        <p className="mt-4 text-sm text-muted">Reading and downscaling files…</p>
      )}
      {stage === "extracting" && (
        <p className="mt-4 text-sm text-muted">
          Extracting {progress.done} of {progress.total} receipts…
        </p>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {failures.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">
            {failures.length} file{failures.length > 1 ? "s" : ""} could not be
            processed:
          </p>
          <ul className="mt-1 list-inside list-disc">
            {failures.map((f, i) => (
              <li key={i}>
                <span className="font-medium">{f.fileName}</span> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Review grid */}
      {rows.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-medium">{rows.length}</span>{" "}
              {rows.length === 1 ? "receipt" : "receipts"} · total{" "}
              <span className="font-medium">
                {totalSum.toFixed(2)} {rows[0]?.currency ?? "USD"}
              </span>
              {flaggedCount > 0 && (
                <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                  {flaggedCount} need{flaggedCount === 1 ? "s" : ""} review
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void download("flat")}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Download CSV
              </button>
              {hasLineItems && (
                <button
                  type="button"
                  onClick={() => void download("itemized")}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
                >
                  Download line items
                </button>
              )}
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"
              >
                Clear
              </button>
            </div>
          </div>

          <p className="mb-2 text-xs text-muted">
            Amber cells were flagged as uncertain. Click any cell to correct it —
            edits are included in the export.
          </p>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">File</th>
                  <th className="px-3 py-2 font-medium">Merchant</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium text-right">Subtotal</th>
                  <th className="px-3 py-2 font-medium text-right">Tax</th>
                  <th className="px-3 py-2 font-medium text-right">Tip</th>
                  <th className="px-3 py-2 font-medium text-right">Total</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Conf.</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const flagged = (k: string) => row.flags.includes(k);
                  const lowConf = row.confidence < 0.7;
                  return (
                    <tr
                      key={`${row.file_name}-${i}`}
                      className="border-t border-slate-100"
                    >
                      <td
                        className="max-w-[160px] truncate px-3 py-1.5 text-xs text-muted"
                        title={row.file_name}
                      >
                        {row.file_name}
                      </td>
                      <Cell
                        value={row.merchant}
                        flagged={flagged("merchant")}
                        title={FLAG_LABELS.merchant}
                        onChange={(v) => updateCell(i, "merchant", v)}
                      />
                      <Cell
                        value={row.date}
                        flagged={flagged("date")}
                        title={FLAG_LABELS.date}
                        placeholder="YYYY-MM-DD"
                        onChange={(v) => updateCell(i, "date", v)}
                      />
                      <Cell
                        value={row.subtotal === null ? "" : row.subtotal.toFixed(2)}
                        align="right"
                        flagged={flagged("arithmetic")}
                        title={FLAG_LABELS.arithmetic}
                        onChange={(v) => updateCell(i, "subtotal", v)}
                      />
                      <Cell
                        value={row.tax === null ? "" : row.tax.toFixed(2)}
                        align="right"
                        onChange={(v) => updateCell(i, "tax", v)}
                      />
                      <Cell
                        value={row.tip === null ? "" : row.tip.toFixed(2)}
                        align="right"
                        onChange={(v) => updateCell(i, "tip", v)}
                      />
                      <Cell
                        value={row.total === null ? "" : row.total.toFixed(2)}
                        align="right"
                        bold
                        flagged={flagged("total") || flagged("arithmetic")}
                        title={
                          flagged("total")
                            ? FLAG_LABELS.total
                            : FLAG_LABELS.arithmetic
                        }
                        onChange={(v) => updateCell(i, "total", v)}
                      />
                      <td className="px-3 py-1.5">
                        <select
                          value={row.category}
                          onChange={(e) => updateCell(i, "category", e.target.value)}
                          className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-sm hover:border-slate-300"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td
                        className={`px-3 py-1.5 text-xs ${
                          lowConf ? "font-medium text-amber-700" : "text-muted"
                        }`}
                        title={lowConf ? FLAG_LABELS.lowconfidence : undefined}
                      >
                        {(row.confidence * 100).toFixed(0)}%
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          className="text-xs text-muted hover:text-red-600"
                          aria-label="Remove row"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {rows.some((r) => r.flags.includes("line_items")) && (
            <p className="mt-2 text-xs text-amber-800">
              Some receipts have line items that do not add up to their subtotal.
              The totals above are still correct — check the line-item export
              before relying on it.
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function Cell({
  value,
  onChange,
  flagged = false,
  align = "left",
  bold = false,
  title,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  flagged?: boolean;
  align?: "left" | "right";
  bold?: boolean;
  title?: string;
  placeholder?: string;
}) {
  return (
    <td className={`px-1 py-1 ${flagged ? "bg-amber-50" : ""}`} title={flagged ? title : undefined}>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`cell-input w-full rounded border border-transparent bg-transparent px-2 py-1 hover:border-slate-300 ${
          align === "right" ? "text-right" : ""
        } ${bold ? "font-medium" : ""} ${flagged ? "text-amber-900" : ""}`}
      />
    </td>
  );
}
