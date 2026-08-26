// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fixture capture for connector runs.
 *
 * Two activation modes, both opt-in:
 *
 *   PDPP_CAPTURE_FIXTURES=1   — always retain raw capture (developer mode).
 *                                Used for fixture-scrubber input and explicit
 *                                live-capture sessions.
 *
 *   PDPP_CAPTURE_ON_FAILURE=1 — capture during the run but delete the raw
 *                                directory on success; retain on failure.
 *                                Intended for scheduler/docker contexts where
 *                                operators want a no-cost "first failure has
 *                                artifacts" guarantee, but nothing in this
 *                                repo wires it on automatically — enabling
 *                                it is a deliberate per-environment step.
 *
 * When both are set, PDPP_CAPTURE_FIXTURES wins (always retain). When
 * neither is set, `createCaptureSession` returns null and the runtime
 * makes no automatic capture calls.
 *
 * Active sessions write under `PDPP_CAPTURE_ROOT_DIR/<connector>/raw/<runId>/`.
 * When `PDPP_CAPTURE_ROOT_DIR` is unset, local development defaults to
 * `packages/polyfill-connectors/fixtures/<connector>/raw/<runId>/`.
 * Captured raw kinds:
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
 * The "raw" side is gitignored. A companion scrubber (bin/scrub-fixtures.ts)
 * consumes a run's raw/ and writes sanitized files to scrubbed/ for commit.
 *
 * That scrubber is NOT the credential defense. raw/ persists on the volume and
 * is exactly what a diagnostic agent is pointed at, so a later sanitizing pass
 * cannot un-write a secret that already landed. DOM and ARIA captures are
 * therefore redacted at WRITE TIME by `src/capture-redaction.ts`; see that
 * module for the rules and for what they deliberately do not cover.
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

import { redactAriaSnapshot, redactDomHtml, redactKnownSecrets } from "./capture-redaction.ts";
import type { RecordData } from "./connector-runtime.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CAPTURE_ROOT = join(PACKAGE_ROOT, "fixtures");
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
  ariaSnapshot: (options?: Parameters<ReturnType<Page["locator"]>["ariaSnapshot"]>[0]) => Promise<string>;
  count: () => Promise<number>;
  first: () => LocatorProbeLocator;
  isEnabled: (options?: Parameters<ReturnType<Page["locator"]>["isEnabled"]>[0]) => Promise<boolean>;
  isVisible: () => Promise<boolean>;
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
  captureDom: (page: Page, label: string) => Promise<void>;
  captureHttp: (label: string, body: unknown, meta?: HttpCaptureMeta) => void;
  captureLocatorProbe?: (page: LocatorProbePage, label: string, probes: readonly LocatorProbe[]) => Promise<void>;
  /**
   * Apply post-run retention policy:
   *   - PDPP_CAPTURE_FIXTURES mode: no-op (always retain).
   *   - PDPP_CAPTURE_ON_FAILURE mode: if markSucceeded() was called,
   *     delete the raw run directory. Otherwise retain.
   * Safe to call multiple times; the second call is a no-op.
   */
  finalize: () => void;
  /**
   * True once any credential value has been registered for this run.
   *
   * This is the trace-suppression gate. Playwright records `fill()` action
   * PARAMETERS into `trace.trace`, so a trace taken after a credential is
   * typed contains that credential verbatim and no tracing option removes it.
   * `makeTracer` reads this to decide whether a trace may be persisted.
   * Deliberately a method, not a snapshot boolean: the tracer asks at stop()
   * time, long after credentials resolve.
   */
  hasRegisteredSecrets: () => boolean;
  /** True when this session retains raw fixtures on success. */
  readonly keepOnSuccess: boolean;
  /**
   * Mark the run as successful. Combined with `finalize()`, this drives
   * the failure-only retention policy. With `keepOnSuccess=true` (the
   * always-retain default), calling this has no effect.
   */
  markSucceeded: () => void;
  recordRecord: (msg: { stream: string; data: RecordData }) => void;
  /**
   * Register credential values the run holds so capture can redact them
   * wherever they appear, including fields no rule would recognize as secret.
   * Call as soon as credentials resolve and before any page interaction.
   * Values shorter than the matching floor are ignored — see capture-redaction.
   *
   * Registering ANY value also disarms trace persistence for the run, even a
   * value below the matching floor: the floor governs text substitution, not
   * whether the run handles credentials at all.
   */
  registerSecrets: (values: Iterable<string>) => void;
  readonly runId: string;
  setTraceCheckpointHook?: (hook: ((label: string) => Promise<void>) | null) => void;
}

/**
 * Look up a `getBy*` helper on the page AND bind it back to that page.
 *
 * The bind is load-bearing, not defensive style. Playwright's `Page.getByRole`
 * (and every sibling `getBy*`/`locator`) is a thin delegator whose body is
 * `return this.mainFrame().getByRole(...)`, so extracting the method and
 * calling it detached makes `this` `undefined` and throws the exact string
 * `Cannot read properties of undefined (reading 'mainFrame')`.
 *
 * That is production run_1787537596833's `submit-role` probe: at
 * `venmo-login-after-submit` the role probe recorded that error while the css
 * probes beside it (which call `page.locator(...)` as a method, and so keep
 * their receiver) reported real counts. It reads like a frame/navigation race
 * but is deterministic — it fails on the very first call, on any page, with no
 * navigation involved.
 */
function requireProbeMethod<K extends keyof LocatorProbePage>(
  page: LocatorProbePage,
  key: K
): NonNullable<LocatorProbePage[K]> {
  const method = page[key];
  if (typeof method !== "function") {
    throw new Error(`locator probe page is missing ${String(key)}`);
  }
  return (method as (...args: readonly unknown[]) => unknown).bind(page) as NonNullable<LocatorProbePage[K]>;
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

async function captureDomHtml(
  page: Page,
  baseDir: string,
  label: string,
  safe: string,
  secrets: readonly string[]
): Promise<void> {
  try {
    const html = redactDomHtml(await page.content(), secrets);
    writeFileSync(join(baseDir, "dom", `${safe}.html`), html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] dom write failed for ${label}: ${message}\n`);
  }
}

async function capturePageMetadata(
  page: Page,
  baseDir: string,
  label: string,
  safe: string,
  secrets: readonly string[]
): Promise<void> {
  try {
    const title = await page.title().catch(() => "");
    writeFileSync(
      join(baseDir, "pages", `${safe}.json`),
      // A credential can reach a URL (a token in a query string) or a title.
      redactKnownSecrets(
        JSON.stringify(
          {
            captured_at: new Date().toISOString(),
            label,
            title,
            url: page.url(),
          },
          null,
          2
        ),
        secrets
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] page metadata write failed for ${label}: ${message}\n`);
  }
}

async function captureAriaSnapshot(
  page: Page,
  baseDir: string,
  label: string,
  safe: string,
  secrets: readonly string[]
): Promise<void> {
  try {
    const ariaSnapshot = redactAriaSnapshot(
      await page.ariaSnapshot({
        depth: Number(process.env.PDPP_CAPTURE_ARIA_DEPTH ?? 8),
        mode: "ai",
        timeout: ARIA_SNAPSHOT_TIMEOUT_MS,
      }),
      secrets
    );
    writeFileSync(join(baseDir, "aria", `${safe}.aria.yml`), ariaSnapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] aria snapshot failed for ${label}: ${message}\n`);
  }
}

/**
 * Write a viewport screenshot, masking any field that could render a
 * credential as readable pixels.
 *
 * A screenshot is the one capture kind no text rule can clean: the bytes are
 * an image, so `grep` sees nothing and the redaction helpers have no purchase.
 * `type="password"` renders as dots and is safe on its own, but a
 * one-time-code input is conventionally `type="text"` and renders the digits
 * PLAINLY. Two live paths do exactly that — venmo `venmo-otp-after-submit`
 * and reddit `reddit-otp-after-submit` both screenshot immediately after
 * filling an OTP field, and their submit clicks are best-effort, so a failed
 * click leaves the code on screen.
 *
 * Playwright's `mask` option paints an opaque box over each matched element
 * before the pixels are read, so the credential is never encoded into the PNG
 * at all — as opposed to being written and then cleaned. The surrounding page
 * still renders, which is what makes the screenshot worth keeping.
 */
const SCREENSHOT_MASK_SELECTOR = [
  "input[type=password]",
  "input[autocomplete=one-time-code]",
  "input[autocomplete=current-password]",
  "input[autocomplete=new-password]",
  'input[name="otp"]',
  'input[name="code"]',
  'input[name="smsCode"]',
  'input[name="verification_code"]',
  'input[inputmode="numeric"]',
  "input[type=tel]",
].join(", ");

async function captureScreenshot(page: Page, baseDir: string, label: string, safe: string): Promise<void> {
  try {
    // `mask` needs a real Locator. Build it defensively so a page-like object
    // without `locator` (test doubles, reduced surfaces) degrades to no
    // screenshot rather than an unmasked one — never write pixels we cannot
    // prove are masked.
    const mask = typeof page.locator === "function" ? [page.locator(SCREENSHOT_MASK_SELECTOR)] : null;
    if (!mask) {
      process.stderr.write(`[capture] screenshot skipped for ${label}: page cannot build a credential mask\n`);
      return;
    }
    const screenshot = await page.screenshot({ fullPage: false, mask, type: "png" });
    writeFileSync(join(baseDir, "screenshots", `${safe}.png`), screenshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[capture] screenshot write failed for ${label}: ${message}\n`);
  }
}

async function runLocatorProbe(
  page: LocatorProbePage,
  probe: LocatorProbe,
  secrets: readonly string[]
): Promise<LocatorProbeResult> {
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
        // Same leak channel as the page-level snapshot: a probe aimed at a
        // password field serializes that field's value.
        result.ariaSnapshot = redactAriaSnapshot(ariaSnapshot, secrets);
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
  results: readonly LocatorProbeResult[],
  secrets: readonly string[]
): Promise<void> {
  try {
    writeFileSync(
      join(baseDir, "locators", `${safe}.json`),
      // Each probe's ariaSnapshot is already redacted by runLocatorProbe; this
      // second pass covers the report's own url/title fields and any probe
      // selector or error message that quoted a credential back.
      redactKnownSecrets(
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
        ),
        secrets
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
  const configuredRoot = process.env.PDPP_CAPTURE_ROOT_DIR?.trim();
  const captureRoot = configuredRoot && configuredRoot.length > 0 ? configuredRoot : DEFAULT_CAPTURE_ROOT;
  const baseDir = join(captureRoot, connectorName, "raw", runId);
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
  const secrets = new Set<string>();
  // Tracked separately from `secrets.size` so that a credential too short to
  // be matched verbatim still suppresses traces. "Did this run handle a
  // credential?" and "can we substring-match it?" are different questions.
  let sawAnySecret = false;
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
    registerSecrets(values): void {
      for (const value of values) {
        if (typeof value === "string" && value.length > 0) {
          secrets.add(value);
          sawAnySecret = true;
        }
      }
    },
    hasRegisteredSecrets(): boolean {
      return sawAnySecret;
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
        // Identity-based redaction only. records/ holds connector-emitted
        // payloads with no form structure, so there is no field slot to reason
        // about — but a credential echoed back by an API (a session token in a
        // profile response) is still a credential landing on disk.
        appendFileSync(file, `${redactKnownSecrets(JSON.stringify(msg.data), [...secrets])}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] record write failed: ${message}\n`);
      }
    },
    async captureDom(page, label): Promise<void> {
      const safe = safeLabel(label);
      const knownSecrets = [...secrets];
      await captureDomHtml(page, baseDir, label, safe, knownSecrets);
      await capturePageMetadata(page, baseDir, label, safe, knownSecrets);
      await captureAriaSnapshot(page, baseDir, label, safe, knownSecrets);
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
      const knownSecrets = [...secrets];
      const results = await Promise.all(probes.map((probe) => runLocatorProbe(page, probe, knownSecrets)));
      await writeLocatorProbeReport(page, baseDir, label, safe, results, knownSecrets);
    },
    captureHttp(label, body, meta = {}): void {
      try {
        httpSeq += 1;
        const idx = String(httpSeq).padStart(4, "0");
        const file = join(baseDir, "http", `${idx}-${safeLabel(label)}.json`);
        const payload = { label, meta, body };
        // meta carries request URLs, which is where a credential in a query
        // string would appear; body carries whatever the endpoint returned.
        // Both are free-form, so identity matching is the only rule that
        // applies — see capture-redaction for why shape matching cannot work.
        writeFileSync(file, redactKnownSecrets(JSON.stringify(payload, null, 2), [...secrets]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] http write failed for ${label}: ${message}\n`);
      }
    },
  };
}
