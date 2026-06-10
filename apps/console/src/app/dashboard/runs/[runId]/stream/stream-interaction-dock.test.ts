import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url)), "utf8");
const manualCompletionLabelPattern = /Mark browser step complete/;
const hideInstructionsPattern = /Hide instructions/;
const showInstructionsPattern = /Show step instructions/;
const oldCompletionLabelPattern = /I'm done/;
const collapsedStatePattern = /const \[collapsed, setCollapsed\] = useState\(false\)/;
const hideClickPattern = /onClick=\{\(\) => setCollapsed\(true\)\}/;
const showClickPattern = /onClick=\{\(\) => setCollapsed\(false\)\}/;
const hideButtonSubmitPattern = /onClick=\{\(\) => submitInteraction\(\)\}[\s\S]{0,120}>[\s\S]{0,80}Hide instructions/;
// The corner close button is the only stream-killer on this surface. An owner
// mid-auth read the icon-only X as "dismiss this notice" and lost the session,
// so its label must say it ENDS the browser session, never an ambiguous "Close".
const endSessionLabelPattern = /aria-label=\{`End \$\{connectorName\} browser session`\}/;
const oldCloseLabelPattern = /aria-label=\{`Close \$\{connectorName\} browser`\}/;

// Close-on-pending-interaction guard. The corner X must not call the raw
// `onClose` directly; it routes through a guarded handler that, when a
// manual_action/otp interaction is pending, arms an inline confirmation
// instead of tearing the session down. When nothing is pending it closes
// immediately, so unprotected behavior is unchanged.
const cornerRoutesThroughGuardPattern = /<CornerControls[\s\S]{0,200}onClose=\{handleCloseRequest\}/;
// The guard is gated on a pending interaction, derived from the same
// SUPPORTED_KINDS predicate (manual_action/otp) that renders the dock — not a
// new ad-hoc predicate. When pending it arms the confirm bubble and returns
// WITHOUT calling onClose.
const guardGatedOnPendingPattern =
  /const interactionPending = SUPPORTED_KINDS\.has\(interactionKind\);[\s\S]{0,400}if \(interactionPending\) \{[\s\S]{0,200}setCloseConfirmArmed\(true\);[\s\S]{0,40}return;/;
// Only the explicit "End browser session" press in the bubble actually closes.
const confirmEndsSessionPattern = /handleCloseConfirm = useCallback\(\(\) => \{[\s\S]{0,200}onClose\(\);/;
// The native, lint-banned window.confirm must NOT be used as the guard.
const noNativeConfirmPattern = /window\.confirm\(/;
// The bubble's copy must name ending as destructive and point the owner at the
// non-destructive "Hide instructions" alternative so the two never blur.
const guardCopyPattern = /End the \{connectorName\} browser session now\?[\s\S]{0,260}Hide\n?\s*instructions/;
// When no interaction is pending, the guarded handler falls straight through
// to onClose() outside the `if (interactionPending)` block — unchanged.
const guardFallsThroughWhenIdlePattern = /if \(interactionPending\) \{[\s\S]{0,200}return;\n\s*\}\n\s*onClose\(\);/;
// Hiding instructions (the dock's collapse control) must stay independent of
// the close guard: it only flips `collapsed`, never arms the close bubble or
// ends the session.
const hideDoesNotArmClosePattern = /onClick=\{\(\) => setCollapsed\(true\)\}/;

test("manual browser step controls distinguish hiding from completion", () => {
  assert.match(source, manualCompletionLabelPattern);
  assert.match(source, hideInstructionsPattern);
  assert.match(source, showInstructionsPattern);
  assert.doesNotMatch(source, oldCompletionLabelPattern);
});

test("hiding browser step instructions does not submit the interaction", () => {
  assert.match(source, collapsedStatePattern);
  assert.match(source, hideClickPattern);
  assert.match(source, showClickPattern);
  assert.doesNotMatch(source, hideButtonSubmitPattern);
});

test("the stream-killer corner control names itself as ending the session", () => {
  assert.match(source, endSessionLabelPattern);
  assert.doesNotMatch(source, oldCloseLabelPattern);
});

test("ending the session while a manual/browser interaction is pending is guarded", () => {
  // The corner X must route through the guarded handler, not raw onClose.
  assert.match(source, cornerRoutesThroughGuardPattern);
  // The guard is gated on the same SUPPORTED_KINDS predicate that renders the
  // dock, and arms-then-returns rather than closing immediately.
  assert.match(source, guardGatedOnPendingPattern);
  // Only the explicit confirmation actually ends the session.
  assert.match(source, confirmEndsSessionPattern);
  // The guard must not use the lint-banned, obtrusive native confirm.
  assert.doesNotMatch(source, noNativeConfirmPattern);
});

test("the close guard names ending as destructive and points at hiding instead", () => {
  assert.match(source, guardCopyPattern);
});

test("no confirmation is required when no manual/browser interaction is pending", () => {
  // With nothing pending, the guarded handler falls straight through to
  // onClose() outside the `if (interactionPending)` block — unchanged behavior.
  assert.match(source, guardFallsThroughWhenIdlePattern);
});

test("hiding instructions does not arm the close guard or end the session", () => {
  // The dock's "Hide instructions" control only flips `collapsed`; it must not
  // touch the close-confirm state or submit/end the session.
  assert.match(source, hideDoesNotArmClosePattern);
  assert.doesNotMatch(source, hideButtonSubmitPattern);
});
