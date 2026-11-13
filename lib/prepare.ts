/**
 * prepare.ts — client-side file preparation.
 *
 * Runs in the browser so that:
 *   - large phone photos are downscaled before upload (faster, cheaper, and
 *     avoids Vercel's request body limit)
 *   - PDFs are rasterized to images, since the vision model needs pixels
 *   - HEIC and other exotic formats are normalized to JPEG by the canvas
 */

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.82;

export interface PreparedFile {
  fileName: string;
  dataUrl: string;
  previewUrl: string;
}

export async function prepareFiles(files: File[]): Promise<{
  prepared: PreparedFile[];
  errors: { fileName: string; error: string }[];
}> {
  const prepared: PreparedFile[] = [];
  const errors: { fileName: string; error: string }[] = [];

  for (const file of files) {
    try {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const pages = await rasterizePdf(file);
        pages.forEach((dataUrl, i) => {
          prepared.push({
            fileName:
              pages.length > 1 ? `${file.name} (p${i + 1})` : file.name,
            dataUrl,
            previewUrl: dataUrl,
          });
        });
      } else if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
        const dataUrl = await downscaleImage(file);
        prepared.push({ fileName: file.name, dataUrl, previewUrl: dataUrl });
      } else {
        errors.push({
          fileName: file.name,
          error: "Unsupported file type. Use JPG, PNG, WEBP, HEIC or PDF.",
        });
      }
    } catch (err) {
      errors.push({
        fileName: file.name,
        error:
          err instanceof Error
            ? err.message
            : "Could not read this file in the browser.",
      });
    }
  }

  return { prepared, errors };
}

/** Draw the image to a canvas at a bounded size and re-encode as JPEG. */
async function downscaleImage(file: File): Promise<string> {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(
    1,
    MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
  );
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  // White backdrop: transparent PNGs would otherwise flatten to black and
  // become unreadable to the model.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if ("close" in bitmap) (bitmap as ImageBitmap).close?.();

  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* HEIC and some formats fail here; fall back to an <img> */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          "This browser cannot decode that image format. Try converting it to JPG.",
        ),
      );
    };
    img.src = url;
  });
}

/**
 * Rasterize each PDF page to a JPEG data URL using pdf.js loaded on demand
 * from a CDN, so the dependency costs nothing until someone drops a PDF.
 */
async function rasterizePdf(file: File): Promise<string[]> {
  const pdfjs = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  const MAX_PAGES = 10;
  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const out: string[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      2,
      MAX_EDGE_PX / Math.max(baseViewport.width, baseViewport.height),
    );
    const viewport = page.getViewport({ scale: Math.max(scale, 1) });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable in this browser.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    out.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
  }

  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let pdfJsPromise: Promise<any> | null = null;

function loadPdfJs(): Promise<any> {
  if (pdfJsPromise) return pdfJsPromise;
  pdfJsPromise = (async () => {
    const version = "4.10.38";
    const src = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.min.mjs`;
    const mod = await import(/* webpackIgnore: true */ src);
    const lib = mod.default ?? mod;
    lib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.worker.min.mjs`;
    return lib;
  })();
  return pdfJsPromise;
}
