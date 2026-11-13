/**
 * extract.ts — OpenRouter vision call.
 *
 * Isolated from the API route so the model provider can be swapped without
 * touching HTTP handling. OpenRouter is used because it is already the
 * configured provider; it speaks the OpenAI chat-completions dialect, so
 * switching to OpenAI direct is a base-URL change.
 */

import { MODEL, SYSTEM_PROMPT, USER_PROMPT } from "./prompt";
import { RECEIPT_JSON_SCHEMA } from "./schema";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

/**
 * Send one image to the vision model and return the parsed JSON object.
 * Retries on 429 and 5xx with exponential backoff.
 */
export async function extractReceipt(
  dataUrl: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ExtractionError("OPENROUTER_API_KEY is not configured", 500);
  }

  // Reasoning models (OpenAI gpt-5*, o*) reject `max_tokens` and require
  // `max_completion_tokens`. Send the right one so the model is swappable via
  // the VISION_MODEL env var without a code change.
  const isReasoning = /(^|\/)(gpt-5|o[1-9])/.test(MODEL);
  const tokenLimit = isReasoning
    ? { max_completion_tokens: 4000 }
    : { max_tokens: 2000 };

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
    ...tokenLimit,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "receipt",
        strict: true,
        schema: RECEIPT_JSON_SCHEMA,
      },
    },
  };

  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://receipt-to-csv.vercel.app",
          "X-Title": "Receipt to CSV",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = `upstream ${res.status}`;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(600 * 2 ** (attempt - 1));
          continue;
        }
        throw new ExtractionError(
          "The extraction service is busy. Try again in a moment.",
          503,
        );
      }

      if (!res.ok) {
        const detail = await safeText(res);
        // Never surface raw provider JSON to the user — it looks broken and can
        // leak upstream implementation details. Map to a human sentence.
        throw new ExtractionError(friendlyUpstreamError(res.status, detail), 502);
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new ExtractionError("Model returned an empty response", 502);
      }

      return parseModelJson(content);
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        lastError = "timeout";
        if (attempt < MAX_ATTEMPTS) {
          await sleep(600 * 2 ** (attempt - 1));
          continue;
        }
        throw new ExtractionError("Extraction timed out", 504);
      }
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(600 * 2 ** (attempt - 1));
        continue;
      }
      throw new ExtractionError(`Extraction failed: ${lastError}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ExtractionError(`Extraction failed: ${lastError}`, 502);
}

/**
 * Parse the model's content field. Even with strict json_schema, some models
 * wrap output in markdown fences, so strip them defensively.
 */
function parseModelJson(content: string): Record<string, unknown> {
  let s = content.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    throw new Error("not an object");
  } catch {
    // Last resort: grab the outermost brace pair.
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first > -1 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    throw new ExtractionError("Model returned unparseable JSON", 502);
  }
}

/**
 * Turn an upstream error body into a sentence a non-technical user can act on.
 * Raw provider JSON must never reach the UI.
 */
function friendlyUpstreamError(status: number, detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes("unsupported image") || d.includes("invalid image") || d.includes("image is valid")) {
    return "This file could not be read as an image. Try a JPG or PNG photo of the receipt.";
  }
  if (d.includes("content policy") || d.includes("safety")) {
    return "The extraction service declined to process this image.";
  }
  if (d.includes("credit") || d.includes("quota") || d.includes("insufficient")) {
    return "The extraction service is out of credit. Please contact the site owner.";
  }
  if (status === 401 || status === 403) {
    return "The extraction service rejected the request. Please contact the site owner.";
  }
  if (d.includes("too large") || status === 413) {
    return "This image is too large to process. Try a smaller photo.";
  }
  return "This receipt could not be processed. Try a clearer photo.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
