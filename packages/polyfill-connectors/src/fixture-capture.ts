/**
 * Fixture capture for connector runs.
 *
 * Gated on PDPP_CAPTURE_FIXTURES=1. When active, writes under
 * `packages/polyfill-connectors/fixtures/<connector>/raw/<runId>/` local raw
 * kinds of capture:
 *
 *   records/<stream>.jsonl     one JSON per emitted RECORD.data (generic,
 *                               free to any connector that uses a shared
 *                               runtime — emit() is wrapped to append)
 *   dom/<label>.html           Playwright page.content() snapshots at
 *                               connector-chosen checkpoints
 *   pages/<label>.json         URL/title/timestamp metadata for page captures
 *   screenshots/<label>.png    best-effort viewport screenshots for visual
 *                               debugging
 *   traces/*.zip               Playwright traces when a browser connector runs
 *   http/<nnnn>-<label>.json   HTTP response bodies for API connectors
 *
 * The "raw" side is gitignored. A companion scrubber (bin/scrub-fixtures.mjs)
 * consumes a run's raw/ and writes sanitized files to scrubbed/ for commit.
 *
 * runId is an ISO-timestamp folder so repeated runs accumulate rather than
 * overwriting — useful when diffing runs or when the first run fails partway.
 *
 * All capture is best-effort: if the filesystem is unavailable, we warn to
 * stderr and return null so the real run proceeds unimpeded. Capture must
 * never make a connector fail.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright";

import type { RecordData } from "./connector-runtime.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const safeLabel = (s: string): string =>
  String(s)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120);

/** Metadata for a single captured HTTP response. */
export interface HttpCaptureMeta {
  method?: string;
  path?: string;
  status?: number;
  [extra: string]: unknown;
}

/** Handle returned by createCaptureSession when capture is enabled. */
export interface CaptureSession {
  readonly baseDir: string;
  captureDom(page: Page, label: string): Promise<void>;
  captureHttp(label: string, body: unknown, meta?: HttpCaptureMeta): void;
  recordRecord(msg: { stream: string; data: RecordData }): void;
  readonly runId: string;
  setTraceCheckpointHook?(hook: ((label: string) => Promise<void>) | null): void;
}

export function createCaptureSession(connectorName: string): CaptureSession | null {
  if (process.env.PDPP_CAPTURE_FIXTURES !== "1") {
    return null;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(PACKAGE_ROOT, "fixtures", connectorName, "raw", runId);
  try {
    mkdirSync(join(baseDir, "records"), { recursive: true });
    mkdirSync(join(baseDir, "dom"), { recursive: true });
    mkdirSync(join(baseDir, "pages"), { recursive: true });
    mkdirSync(join(baseDir, "screenshots"), { recursive: true });
    mkdirSync(join(baseDir, "traces"), { recursive: true });
    mkdirSync(join(baseDir, "http"), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] mkdir failed: ${message}\n`);
    return null;
  }

  let httpSeq = 0;
  let traceCheckpointHook: ((label: string) => Promise<void>) | null = null;

  return {
    runId,
    baseDir,
    setTraceCheckpointHook(hook): void {
      traceCheckpointHook = hook;
    },
    recordRecord(msg): void {
      try {
        const file = join(baseDir, "records", `${safeLabel(msg.stream)}.jsonl`);
        appendFileSync(file, `${JSON.stringify(msg.data)}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] record write failed: ${message}\n`);
      }
    },
    async captureDom(page, label): Promise<void> {
      const safe = safeLabel(label);
      try {
        const html = await page.content();
        writeFileSync(join(baseDir, "dom", `${safe}.html`), html);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] dom write failed for ${label}: ${message}\n`);
      }
      try {
        const title = await page.title().catch(() => "");
        writeFileSync(
          join(baseDir, "pages", `${safe}.json`),
          JSON.stringify(
            {
              captured_at: new Date().toISOString(),
              label,
              title,
              url: page.url(),
            },
            null,
            2
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] page metadata write failed for ${label}: ${message}\n`);
      }
      try {
        const screenshot = await page.screenshot({ fullPage: false, type: "png" });
        writeFileSync(join(baseDir, "screenshots", `${safe}.png`), screenshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] screenshot write failed for ${label}: ${message}\n`);
      }
      if (traceCheckpointHook) {
        await traceCheckpointHook(label).catch((err: unknown): undefined => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[capture] trace checkpoint failed for ${label}: ${message}\n`);
        });
      }
    },
    captureHttp(label, body, meta = {}): void {
      try {
        httpSeq += 1;
        const idx = String(httpSeq).padStart(4, "0");
        const file = join(baseDir, "http", `${idx}-${safeLabel(label)}.json`);
        const payload = { label, meta, body };
        writeFileSync(file, JSON.stringify(payload, null, 2));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] http write failed for ${label}: ${message}\n`);
      }
    },
  };
}
