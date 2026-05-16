/**
 * Fixture capture for connector runs.
 *
 * Two activation modes:
 *
 *   PDPP_CAPTURE_FIXTURES=1   — always retain raw capture (developer mode).
 *                                Used for fixture-scrubber input and explicit
 *                                live-capture sessions.
 *
 *   PDPP_CAPTURE_ON_FAILURE=1 — capture during the run but delete the raw
 *                                directory on success; retain on failure.
 *                                Default mode for scheduler/docker runs so
 *                                the first time a connector fails the
 *                                operator already has DOM/ARIA/screenshots/
 *                                trace chunks for post-mortem debugging
 *                                without paying storage on success.
 *
 * When both are set, PDPP_CAPTURE_FIXTURES wins (always retain). When
 * neither is set, `createCaptureSession` returns null and the runtime
 * makes no automatic capture calls.
 *
 * Active sessions write under
 * `packages/polyfill-connectors/fixtures/<connector>/raw/<runId>/` local raw
 * kinds of capture:
 *
 *   records/<stream>.jsonl     one JSON per emitted RECORD.data (generic,
 *                               free to any connector that uses a shared
 *                               runtime — emit() is wrapped to append)
 *   dom/<label>.html           Playwright page.content() snapshots at
 *                               connector-chosen checkpoints
 *   pages/<label>.json         URL/title/timestamp metadata for page captures
 *   aria/<label>.aria.yml      best-effort Playwright ARIA snapshot for
 *                               semantic selector design
 *   locators/<label>.json      optional connector-supplied locator probes
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

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright";

import type { RecordData } from "./connector-runtime.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARIA_SNAPSHOT_TIMEOUT_MS = 2000;
const LOCATOR_PROBE_TIMEOUT_MS = 1000;
const LOCATOR_PROBE_ARIA_DEPTH = 2;

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

export type LocatorProbe =
  | {
      description?: string;
      id: string;
      kind: "css";
      selector: string;
    }
  | {
      description?: string;
      exact?: boolean;
      id: string;
      kind: "label";
      text: string;
    }
  | {
      description?: string;
      exact?: boolean;
      id: string;
      kind: "placeholder";
      text: string;
    }
  | {
      description?: string;
      exact?: boolean;
      id: string;
      kind: "role";
      name?: string;
      namePattern?: string;
      nameFlags?: string;
      role: Parameters<Page["getByRole"]>[0];
    }
  | {
      description?: string;
      exact?: boolean;
      id: string;
      kind: "text";
      text: string;
    };

interface LocatorProbeLocator {
  ariaSnapshot(options?: Parameters<ReturnType<Page["locator"]>["ariaSnapshot"]>[0]): Promise<string>;
  count(): Promise<number>;
  first(): LocatorProbeLocator;
  isEnabled(options?: Parameters<ReturnType<Page["locator"]>["isEnabled"]>[0]): Promise<boolean>;
  isVisible(): Promise<boolean>;
}

export type LocatorProbePage = Pick<Page, "title" | "url"> & {
  getByLabel?: (
    text: Parameters<Page["getByLabel"]>[0],
    options?: Parameters<Page["getByLabel"]>[1]
  ) => LocatorProbeLocator;
  getByPlaceholder?: (
    text: Parameters<Page["getByPlaceholder"]>[0],
    options?: Parameters<Page["getByPlaceholder"]>[1]
  ) => LocatorProbeLocator;
  getByRole?: (
    role: Parameters<Page["getByRole"]>[0],
    options?: Parameters<Page["getByRole"]>[1]
  ) => LocatorProbeLocator;
  getByText?: (
    text: Parameters<Page["getByText"]>[0],
    options?: Parameters<Page["getByText"]>[1]
  ) => LocatorProbeLocator;
  locator: (selector: Parameters<Page["locator"]>[0], options?: Parameters<Page["locator"]>[1]) => LocatorProbeLocator;
};

interface LocatorProbeResult {
  ariaSnapshot?: string;
  count?: number;
  description?: string;
  enabled?: boolean;
  error?: string;
  id: string;
  kind: LocatorProbe["kind"];
  probe: Omit<LocatorProbe, "description" | "id" | "kind">;
  visible?: boolean;
}

/** Handle returned by createCaptureSession when capture is enabled. */
export interface CaptureSession {
  readonly baseDir: string;
  captureDom(page: Page, label: string): Promise<void>;
  captureHttp(label: string, body: unknown, meta?: HttpCaptureMeta): void;
  captureLocatorProbe?(page: LocatorProbePage, label: string, probes: readonly LocatorProbe[]): Promise<void>;
  /**
   * Apply post-run retention policy:
   *   - PDPP_CAPTURE_FIXTURES mode: no-op (always retain).
   *   - PDPP_CAPTURE_ON_FAILURE mode: if markSucceeded() was called,
   *     delete the raw run directory. Otherwise retain.
   * Safe to call multiple times; the second call is a no-op.
   */
  finalize(): void;
  /** True when this session retains raw fixtures on success. */
  readonly keepOnSuccess: boolean;
  /**
   * Mark the run as successful. Combined with `finalize()`, this drives
   * the failure-only retention policy. With `keepOnSuccess=true` (the
   * always-retain default), calling this has no effect.
   */
  markSucceeded(): void;
  recordRecord(msg: { stream: string; data: RecordData }): void;
  readonly runId: string;
  setTraceCheckpointHook?(hook: ((label: string) => Promise<void>) | null): void;
}

function requireProbeMethod<K extends keyof LocatorProbePage>(
  page: LocatorProbePage,
  key: K
): NonNullable<LocatorProbePage[K]> {
  const method = page[key];
  if (typeof method !== "function") {
    throw new Error(`locator probe page is missing ${String(key)}`);
  }
  return method as NonNullable<LocatorProbePage[K]>;
}

function locatorForProbe(page: LocatorProbePage, probe: LocatorProbe): LocatorProbeLocator {
  switch (probe.kind) {
    case "css":
      return page.locator(probe.selector);
    case "label":
      return requireProbeMethod(page, "getByLabel")(
        probe.text,
        probe.exact === undefined ? undefined : { exact: probe.exact }
      );
    case "placeholder":
      return requireProbeMethod(page, "getByPlaceholder")(
        probe.text,
        probe.exact === undefined ? undefined : { exact: probe.exact }
      );
    case "role": {
      const name = probe.namePattern ? new RegExp(probe.namePattern, probe.nameFlags ?? "i") : probe.name;
      return requireProbeMethod(page, "getByRole")(probe.role, {
        ...(probe.exact === undefined ? {} : { exact: probe.exact }),
        ...(name === undefined ? {} : { name }),
      });
    }
    case "text":
      return requireProbeMethod(page, "getByText")(
        probe.text,
        probe.exact === undefined ? undefined : { exact: probe.exact }
      );
    default:
      throw new Error(`unsupported locator probe kind: ${(probe as { kind?: string }).kind ?? "unknown"}`);
  }
}

function probeForReport(probe: LocatorProbe): LocatorProbeResult["probe"] {
  const { description: _description, id: _id, kind: _kind, ...rest } = probe;
  return rest;
}

async function captureDomHtml(page: Page, baseDir: string, label: string, safe: string): Promise<void> {
  try {
    const html = await page.content();
    writeFileSync(join(baseDir, "dom", `${safe}.html`), html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] dom write failed for ${label}: ${message}\n`);
  }
}

async function capturePageMetadata(page: Page, baseDir: string, label: string, safe: string): Promise<void> {
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
}

async function captureAriaSnapshot(page: Page, baseDir: string, label: string, safe: string): Promise<void> {
  try {
    const ariaSnapshot = await page.ariaSnapshot({
      depth: Number(process.env.PDPP_CAPTURE_ARIA_DEPTH ?? 8),
      mode: "ai",
      timeout: ARIA_SNAPSHOT_TIMEOUT_MS,
    });
    writeFileSync(join(baseDir, "aria", `${safe}.aria.yml`), ariaSnapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] aria snapshot failed for ${label}: ${message}\n`);
  }
}

async function captureScreenshot(page: Page, baseDir: string, label: string, safe: string): Promise<void> {
  try {
    const screenshot = await page.screenshot({ fullPage: false, type: "png" });
    writeFileSync(join(baseDir, "screenshots", `${safe}.png`), screenshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] screenshot write failed for ${label}: ${message}\n`);
  }
}

async function runLocatorProbe(page: LocatorProbePage, probe: LocatorProbe): Promise<LocatorProbeResult> {
  const result: LocatorProbeResult = {
    id: probe.id,
    kind: probe.kind,
    probe: probeForReport(probe),
  };
  if (probe.description !== undefined) {
    result.description = probe.description;
  }
  try {
    const locator = locatorForProbe(page, probe);
    result.count = await locator.count();
    if (result.count > 0) {
      const first = locator.first();
      result.visible = await first.isVisible();
      result.enabled = await first.isEnabled({ timeout: LOCATOR_PROBE_TIMEOUT_MS }).catch((): boolean => false);
      const ariaSnapshot = await first
        .ariaSnapshot({
          depth: LOCATOR_PROBE_ARIA_DEPTH,
          mode: "ai",
          timeout: LOCATOR_PROBE_TIMEOUT_MS,
        })
        .catch((): undefined => undefined);
      if (ariaSnapshot !== undefined) {
        result.ariaSnapshot = ariaSnapshot;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

async function writeLocatorProbeReport(
  page: LocatorProbePage,
  baseDir: string,
  label: string,
  safe: string,
  results: readonly LocatorProbeResult[]
): Promise<void> {
  try {
    writeFileSync(
      join(baseDir, "locators", `${safe}.json`),
      JSON.stringify(
        {
          captured_at: new Date().toISOString(),
          label,
          probes: results,
          title: await page.title().catch((): string => ""),
          url: page.url(),
        },
        null,
        2
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] locator probe write failed for ${label}: ${message}\n`);
  }
}

export function createCaptureSession(connectorName: string): CaptureSession | null {
  const alwaysRetain = process.env.PDPP_CAPTURE_FIXTURES === "1";
  const onFailureOnly = process.env.PDPP_CAPTURE_ON_FAILURE === "1";
  if (!(alwaysRetain || onFailureOnly)) {
    return null;
  }
  // PDPP_CAPTURE_FIXTURES wins over PDPP_CAPTURE_ON_FAILURE if both set —
  // explicit always-retain trumps conditional retain.
  const keepOnSuccess = alwaysRetain;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(PACKAGE_ROOT, "fixtures", connectorName, "raw", runId);
  try {
    mkdirSync(join(baseDir, "records"), { recursive: true });
    mkdirSync(join(baseDir, "aria"), { recursive: true });
    mkdirSync(join(baseDir, "dom"), { recursive: true });
    mkdirSync(join(baseDir, "locators"), { recursive: true });
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
  let succeeded = false;
  let finalized = false;

  return {
    runId,
    baseDir,
    keepOnSuccess,
    setTraceCheckpointHook(hook): void {
      traceCheckpointHook = hook;
    },
    markSucceeded(): void {
      succeeded = true;
    },
    finalize(): void {
      if (finalized) {
        return;
      }
      finalized = true;
      if (keepOnSuccess || !succeeded) {
        return;
      }
      try {
        rmSync(baseDir, { force: true, recursive: true });
        process.stderr.write(`[capture] run succeeded; raw capture deleted (${baseDir})\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] cleanup failed for ${baseDir}: ${message}\n`);
      }
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
      await captureDomHtml(page, baseDir, label, safe);
      await capturePageMetadata(page, baseDir, label, safe);
      await captureAriaSnapshot(page, baseDir, label, safe);
      await captureScreenshot(page, baseDir, label, safe);
      if (traceCheckpointHook) {
        await traceCheckpointHook(label).catch((err: unknown): undefined => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[capture] trace checkpoint failed for ${label}: ${message}\n`);
        });
      }
    },
    async captureLocatorProbe(page, label, probes): Promise<void> {
      const safe = safeLabel(label);
      const results = await Promise.all(probes.map((probe) => runLocatorProbe(page, probe)));
      await writeLocatorProbeReport(page, baseDir, label, safe, results);
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
