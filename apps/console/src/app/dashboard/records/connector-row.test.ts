/**
 * Structural + behavioral coverage for the `next_action` CTA on the
 * connector row.
 *
 * The row itself is a client component with hooks; we don't have a JSX
 * render harness in this app today, so the strategy mirrors
 * `mobile-drawer.test.ts`: assert that the source wires the CTA path
 * the way the brief requires, and verify the underlying contract via
 * the pure formatter (covered separately in `next-action.test.ts`).
 *
 * The cross-cutting invariant is that the row never invents a CTA when
 * `connection_health.next_action` is null — i.e. loading/empty states
 * cannot produce a false action prompt.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatNextAction } from "../lib/next-action.ts";
import type { RefNextAction } from "../lib/ref-client.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROW_FILE = `${HERE}connector-row.tsx`;

const FORMAT_NEXT_ACTION_CALL = /formatNextAction\(connectionHealth\?\.next_action \?\? null\)/;
const PILL_USAGE = /<NextActionPill /;
const PILL_CONDITIONAL = /\{nextAction \? <NextActionPill /;
const LINK_GUARD = /formatted\.actionTarget !== null && formatted\.variant === "structured"/;
const PILL_USES_DETAIL_HREF = /href=\{detailHref\}/;
const PILL_LINKS_RAW_TARGET = /href=\{formatted\.actionTarget\}/;
const DETAILS_UNAVAILABLE = /Details unavailable/;

test("connector-row reads next_action from connection_health and renders a pill", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, FORMAT_NEXT_ACTION_CALL);
  assert.match(src, PILL_USAGE);
});

test("connector-row only renders the pill when formatNextAction returns a value", async () => {
  // No truthy CTA → no pill. Prevents false-action rendering during
  // loading (when connectionHealth itself is undefined) and for
  // healthy/idle states (where next_action is null).
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, PILL_CONDITIONAL);
});

test("connector-row guards link target behind structured + non-null action_target", async () => {
  // The schedule_fallback variant must never appear as a clickable
  // target — the spine knows there's something to do but not what.
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, LINK_GUARD);
});

test("connector-row never links to the spine's raw action_target", async () => {
  // The pill must navigate to the safe in-app destination, not the
  // possibly-secret value the spine carried.
  const src = await readFile(ROW_FILE, "utf8");
  // Find the pill body and confirm the Link href is `detailHref`,
  // not `formatted.actionTarget` (which could carry sensitive data).
  const pillBlock = src.slice(src.indexOf("function NextActionPill"));
  assert.match(pillBlock, PILL_USES_DETAIL_HREF);
  assert.equal(PILL_LINKS_RAW_TARGET.test(pillBlock), false);
});

test("structured next_action with link target produces a clickable pill", () => {
  const structured: RefNextAction = {
    action_target: "dashboard",
    attention_id: "att_otp",
    expires_at: null,
    owner_action: "provide_value",
    reason_code: "otp_required",
    response_contract: "response_required",
    source: "structured",
  };
  const formatted = formatNextAction(structured);
  if (!formatted) {
    assert.fail("expected structured CTA");
  }
  assert.equal(formatted.variant, "structured");
  assert.equal(formatted.actionTarget, "dashboard");
  // No caveat on structured: we know exactly what's needed.
  assert.equal(formatted.caveat, null);
});

test("schedule_fallback next_action is caveated and non-clickable", () => {
  const fallback: RefNextAction = {
    action_target: null,
    attention_id: null,
    expires_at: null,
    owner_action: null,
    reason_code: "browser_runtime_not_configured",
    response_contract: null,
    source: "schedule_fallback",
  };
  const formatted = formatNextAction(fallback);
  if (!formatted) {
    assert.fail("expected schedule_fallback CTA");
  }
  assert.equal(formatted.variant, "schedule_fallback");
  // The pill code path requires both a non-null target AND a structured
  // source to render as a link; a fallback CTA is therefore plain text.
  assert.equal(formatted.actionTarget, null);
  assert.match(formatted.caveat ?? "", DETAILS_UNAVAILABLE);
});

test("null action_target on a structured next_action falls back to plain text", () => {
  // Mirrors the secret-sensitive case in connection-health: the spine
  // suppressed action_target. The pill code path must not invent one.
  const structured: RefNextAction = {
    action_target: null,
    attention_id: "att_secret",
    expires_at: null,
    owner_action: "provide_value",
    reason_code: "otp_required",
    response_contract: "response_required",
    source: "structured",
  };
  const formatted = formatNextAction(structured);
  if (!formatted) {
    assert.fail("expected structured CTA");
  }
  assert.equal(formatted.actionTarget, null);
});

test("null next_action surfaces no CTA at all", () => {
  assert.equal(formatNextAction(null), null);
});

// ─── 6.1 / 6.5 wiring assertions ───────────────────────────────────────
//
// The row must consume the pure helpers from `connection-evidence.ts`
// rather than reinventing the rules in JSX. These structural assertions
// make the wiring explicit so future edits cannot regress the
// honest-by-default invariants without flipping a test.

const IMPORTS_EVIDENCE_HELPERS =
  /import \{[\s\S]*?formatLastDurableProgress[\s\S]*?formatProjectionFreshness[\s\S]*?resolveRecordCountDisplay[\s\S]*?summarizeAxisChips[\s\S]*?\} from "\.\.\/lib\/connection-evidence\.ts"/;
const USES_RECORD_COUNT_DISPLAY = /resolveRecordCountDisplay\(overview\)/;
const RECORDS_UNAVAILABLE_BRANCH = /recordCount\.label === null/;
const AXIS_CHIPS_STRIP = /data-testid="axis-chip-strip"/;
const PROJECTION_UNRELIABLE_BANNER = /data-testid="projection-unreliable"/;
const FRESHNESS_RESPECTS_ERROR = /hasError=\{Boolean\(overview\.error\)\}/;
const FRESHNESS_UNAVAILABLE_RENDER = /data-testid="freshness-unavailable"/;

test("connector-row imports the connection-evidence helpers", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, IMPORTS_EVIDENCE_HELPERS);
});

test("connector-row uses resolveRecordCountDisplay rather than raw totalRecords for the count", async () => {
  // The raw number must not be rendered without going through the
  // honest-by-default helper, so an evidence error cannot produce a
  // false "0 records" line.
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, USES_RECORD_COUNT_DISPLAY);
  assert.match(src, RECORDS_UNAVAILABLE_BRANCH);
});

test("connector-row renders an axis chip strip when health is present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, AXIS_CHIPS_STRIP);
});

test("connector-row surfaces a projection-unreliable banner when unknown_reasons is non-empty", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, PROJECTION_UNRELIABLE_BANNER);
});

test("connector-row freshness line refuses to render content when evidence collection failed", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, FRESHNESS_RESPECTS_ERROR);
  assert.match(src, FRESHNESS_UNAVAILABLE_RENDER);
});
