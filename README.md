# Receipt to CSV

**Live demo: https://receipt-to-csv-nine.vercel.app**

Drop in receipt photos or PDFs and get an accountant-ready CSV. Every extracted field is shown for review and correction before export.

## The problem

Bookkeeping is the worst place for a confident wrong number. A model that reads a $70.12 grocery total as $7.16 is not "mostly right," it's unusable. So the model had to be chosen by measurement, and every number it returns has to be checked against the others before export.

## Model choice, by measurement

Five vision models scored against real phone photos of crumpled and thermal receipts, with hand-read ground truth (merchant, date, subtotal, tax, total):

| Model | Merchant + date + total | All fields | Cost per receipt |
|---|---|---|---|
| **google/gemini-2.5-flash** | **3/3** | **15/15** | **$0.0023** |
| anthropic/claude-opus-5 | 2/3 | 14/15 | $0.0444 |
| anthropic/claude-sonnet-5 | 2/3 | 14/15 | $0.0209 |
| openai/gpt-4o-mini | 1/3 | 8/15 | $0.0041 |
| anthropic/claude-haiku-4.5 | 1/3 | 7/15 | $0.0039 |

The cheapest model was also the most accurate, about 19x cheaper than the priciest, and it held up on a 3x repeat run (9 of 9 fully correct). That works out to about $2.29 per 1,000 receipts. `gpt-4o-mini` misread a $70.12 total as $7.16. A decimal error disqualifies a bookkeeping model regardless of price.

Change the model with `VISION_MODEL`, then rerun `npm run test:accuracy`. Don't swap models on reputation.

### Provider portability traps (handled)

1. **Anthropic rejects a nullable enum.** `type: ["string","null"]` plus an `enum` fails on Anthropic and passes on OpenAI. Every Anthropic request returns 400, which looks exactly like the model failing the task. `category` is a plain enum'd string in `lib/schema.ts`.
2. **OpenAI reasoning models reject `max_tokens`.** They need `max_completion_tokens`. `lib/extract.ts` sends the right one.

## Design decisions

- **Flag, never silently correct.** If subtotal plus tax plus tip doesn't equal the total, or line items don't add up to the subtotal, the row is flagged and its confidence capped. The numbers are never rewritten. Bookkeepers don't trust software that edits their figures.
- **Confidence is computed last**, after every check, so a flagged row can never show a reassuring score.
- **No database.** State lives in the browser for the session. Receipts are financial documents, and storing nothing removes the whole privacy surface.
- **Images are prepared in the browser.** Photos are downscaled to 1600 px and PDFs rasterized before upload. Requests stay small, the 4.5 MB body cap stops mattering, and nothing is written to disk on the server.

## Run it

```bash
npm install
# create .env.local:
#   OPENROUTER_API_KEY=sk-or-v1-...
#   VISION_MODEL=google/gemini-2.5-flash
npm run dev        # http://localhost:3000
```

The key is read server side only and never reaches the browser.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build, also type-checks |
| `npm test` | 44 logic tests for parsing, validation and CSV rules |
| `npm run test:accuracy` | Live accuracy check against your sample receipts |

**Sample receipts are not in this repo.** The demo's samples are real receipts with real card details, so they stay private. To use the sample buttons and the accuracy test, put your own photos in `public/samples/`, then update the `SAMPLES` array in `app/page.tsx` and the ground truth in `tests/accuracy.mjs`.

## Verified in production

3 of 3 sample receipts and 15 of 15 fields correct, line items reconciling to the subtotal on all three, CSV delivered with edits included. Error paths (empty batch, more than 20 files, malformed data, invalid JSON, a non-receipt image) return readable messages; raw provider errors never reach the UI.

## Layout

```
app/page.tsx              upload UI and editable review grid
app/api/extract/route.ts  images to vision model to validated rows (rate limited)
app/api/export/route.ts   rows to CSV download
lib/schema.ts             zod schema and JSON Schema, single source of truth
lib/prompt.ts             extraction prompt and model setting
lib/normalize.ts          money and date parsing, validation, flagging
lib/csv.ts                RFC 4180 output
lib/extract.ts            OpenRouter client with retry and backoff
lib/ratelimit.ts          per-IP spend guard for the public demo
lib/prepare.ts            browser-side downscaling and PDF rasterization
tests/logic.test.ts       44 assertions, no framework
```

To point it at another document type, edit `lib/schema.ts`, `lib/prompt.ts`, the grid columns in `app/page.tsx`, and the rules in `lib/normalize.ts`. The CSV, client, rate limit and image prep modules are generic.

## Known limits

- Rate limiting is in memory per instance and resets on a cold start. Production needs Redis.
- No auth, saved history or integrations.
- PDF rasterization caps at 10 pages; 20 files per batch.

## Deployment notes

- Vercel rejected Next.js 15.1.6 as vulnerable after a successful build. Pinned to 15.5.22.
- Request bodies cap at 4.5 MB and the platform's error is plain text, not JSON. The browser batches uploads by total size (3 MB) and the API returns a readable message.
- A stray `package-lock.json` in a parent folder made Next pick the wrong workspace root; `outputFileTracingRoot` is pinned in `next.config.js`.
