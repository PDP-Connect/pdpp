/**
 * Pins the honest handling of a *browser-bound* connector deep-link on the
 * device-exporters enrollment page.
 *
 * The records-list "Add a connection" guidance deep-links the supported
 * local-collector set (`?connector=claude_code`/`codex`) into this form. An owner
 * exploring "how do I add Amazon?" can land here with `?connector=amazon` (a
 * browser-bound connector this filesystem-collector form cannot enroll). The page
 * MUST NOT silently drop that intent to a blank form — it must name the connector
 * and point at the owner-run runbook via the shared `connection-modality`
 * classifier, never a faked enroll flow.
 *
 * These are source-text structural invariants, matching the rest of the console
 * test suite (server components have no JSX render harness here). They fail if the
 * page regresses to swallowing a browser-bound deep-link or stops routing through
 * the shared source of truth.
 *
 * See connection-modality.ts and the records-list AddConnectionGuidance callout.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../../../", import.meta.url);

function read(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

const PAGE_PATH = "apps/console/src/app/dashboard/device-exporters/page.tsx";

const USES_CLASSIFIER = /\bisBrowserBoundConnector\b/;
const USES_RUNBOOK_CONST = /\bBROWSER_BOUND_RUNBOOK_PATH\b/;
const IMPORTS_FROM_MODALITY = /from "\.\.\/lib\/connection-modality\.ts"/;
const GATE_EXCLUDES_SUPPORTED = /!defaultConnectorId\s*&&\s*isBrowserBoundConnector\(requestedConnector\)/;
const RENDERS_NOTICE = /browserBoundRequest\s*\?\s*<BrowserBoundEnrollmentNotice/;
const RUNBOOK_TESTID = /data-testid="browser-bound-runbook-path"/;
const RENDERS_RUNBOOK_CONST = /{BROWSER_BOUND_RUNBOOK_PATH}/;
const HONEST_NO_ONE_CLICK = /does not yet offer a one-click flow for browser-bound connectors/;

test("page classifies a browser-bound deep-link via the shared modality classifier (no scattered key checks)", async () => {
  const src = await read(PAGE_PATH);
  // Both symbols must come from the shared connection-modality module so the
  // enroll surface and the records-list guidance tell the same story.
  assert.match(src, USES_CLASSIFIER, "page must use the shared isBrowserBoundConnector classifier");
  assert.match(src, USES_RUNBOOK_CONST, "page must use the shared runbook path constant");
  assert.match(src, IMPORTS_FROM_MODALITY, "browser-bound symbols must come from the shared source of truth");
});

test("a browser-bound deep-link is detected only when it is not a supported local-collector connector", async () => {
  const src = await read(PAGE_PATH);
  // The browser-bound branch must be gated on the connector NOT being the
  // supported (filesystem) set, so a valid claude_code/codex deep-link still
  // prefills the form and never trips the notice.
  assert.match(
    src,
    GATE_EXCLUDES_SUPPORTED,
    "browser-bound notice must only fire for an unsupported, browser-bound connector deep-link"
  );
});

test("a browser-bound deep-link renders an honest notice pointing at the runbook, not a faked enroll flow", async () => {
  const src = await read(PAGE_PATH);
  assert.match(
    src,
    RENDERS_NOTICE,
    "page must render the browser-bound notice when a browser-bound connector is requested"
  );
  assert.match(src, RUNBOOK_TESTID, "the notice must expose a stable hook for the runbook path");
  assert.match(src, RENDERS_RUNBOOK_CONST, "the notice must render the shared runbook path constant");
  // The notice must not advertise a one-click flow: it names the manual procedure
  // rather than implying console enrollment.
  assert.match(
    src,
    HONEST_NO_ONE_CLICK,
    "the notice must stay honest that no console one-click browser-bound flow exists"
  );
});
