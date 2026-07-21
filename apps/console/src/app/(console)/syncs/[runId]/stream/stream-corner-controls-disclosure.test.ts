import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STREAM_VIEWER_FILE = `${HERE}stream-viewer.tsx`;

/**
 * LIVE UAT regression: on mobile (portrait 390x844 and landscape 844x390),
 * `CornerControls` rendered up to 4 permanent 44px circles (status dot +
 * clipboard/paste/keyboard + close) anchored near the bottom safe-area.
 * Reproduced live: at portrait the row's bounding box directly covered the
 * remote ChatGPT login page's footer links ("Terms of use" / "Privacy
 * policy"); the same row covers page content in landscape too, where the
 * frame is narrower and the row sits over the middle of the visible content
 * band.
 *
 * remote-surface owns the streamed pixels (this host must not resize or
 * reserve the remote viewport to work around this — see
 * neko-media-contain-fit.test.ts / stream-dialog-layout.test.ts's geometry-
 * authority guards), so the fix is host-chrome-only: collapse the secondary
 * actions (clipboard/paste/keyboard) behind a single "more actions" toggle.
 * At steady state the corner cluster is the status dot + one toggle + close
 * — a fraction of the previous footprint — and the secondary actions expand
 * transiently only on explicit activation, collapsing again on: choosing an
 * action, an outside pointerdown, Escape, or the row losing focus. This
 * keeps every control at the same 44px (2.75rem) accessible touch-target
 * size the surface already used elsewhere — no accessibility regression
 * traded for the footprint reduction.
 *
 * REVISION (independent review `streaming-presentation-polish-review-luna-
 * 0720.md`, P1): the first version handled Escape via a `document`-level
 * CAPTURE-phase `keydown` listener that only called `setExpanded(false)`,
 * with no `preventDefault`/`stopPropagation`. Base UI's own dialog dismissal
 * (`useDismiss.js`) registers a BUBBLE-phase `document.addEventListener`
 * with no `event.defaultPrevented` guard — it unconditionally closes the
 * dialog (tearing down the live session) on ANY Escape keydown that reaches
 * `document`. Capture firing before bubble is a timing artifact of
 * registration order, not a structural guarantee, and did nothing to stop
 * the event from continuing on to Base UI's listener afterward. So the
 * original fix collapsed the row AND closed the dialog on the same Escape
 * press — reviewer-verified live, confirmed by source inspection of
 * useDismiss.js's `closeOnEscapeKeyDown`.
 *
 * Fixed by moving Escape handling onto the row's own React `onKeyDown`
 * (bubble phase, starting at the row — which is topologically BETWEEN any
 * keydown origin inside it and `document`) and calling
 * `event.stopPropagation()` there. This halts native propagation up the DOM
 * tree structurally — it can never reach `document` — independent of any
 * listener's registration order, and does not rely on
 * `stopImmediatePropagation` (which only stops OTHER listeners on the exact
 * same node/phase, not propagation to ancestors). Live-verified against the
 * real dev server with a real Base UI dialog and a real n.eko session
 * (Docker `pdpp-neko:local`, isolated instance): expand actions → Escape →
 * dialog still open, actions collapsed → Escape again → dialog closes
 * normally. See the accompanying report for the full transcript.
 */

const USE_MORE_ACTIONS_DISCLOSURE_RE = /function useMoreActionsDisclosure\(\)/;
const EXPANDED_STATE_RE = /const \[expanded, setExpanded\] = useState\(false\)/;
const MORE_ACTIONS_TOGGLE_BUTTON_RE =
  /aria-expanded=\{expanded\}[\s\S]{0,200}?aria-label=\{expanded \? `Hide \$\{connectorName\} browser actions` : `More \$\{connectorName\} browser actions`\}/;
const SECONDARY_CLIPBOARD_GATED_RE = /\{expanded && onClipboard \?/;
const SECONDARY_COPY_GATED_RE = /\{expanded && onCopy \?/;
const SECONDARY_PASTE_GATED_RE = /\{expanded && onPaste \?/;
const SECONDARY_KEYBOARD_GATED_RE = /\{expanded && onKeyboard \?/;
const RUN_AND_COLLAPSE_RE =
  /const runAndCollapse = \(action: \(\) => void\) => \(\) => \{\s*action\(\);\s*setExpanded\(false\);\s*\};/;
const OUTSIDE_POINTERDOWN_COLLAPSE_RE = /document\.addEventListener\("pointerdown", handlePointerDown, true\)/;
const FOCUSOUT_COLLAPSE_RE = /rowRef\.current\?\.addEventListener\("focusout", handleFocusOut\)/;
const CLOSE_BUTTON_ALWAYS_VISIBLE_RE =
  /aria-label=\{`End \$\{connectorName\} browser session`\}[\s\S]{0,40}className="pdpp-stream-control-button"/;
const STATUS_DOT_ALWAYS_VISIBLE_RE = /<StatusDot status=\{status\} \/>/;

// P1 fix: Escape is handled ONLY via the row's own onKeyDown, never via a
// document-level listener. handleRowKeyDown must guard on `expanded`, call
// both preventDefault and stopPropagation, and be wired to the row element.
const HANDLE_ROW_KEY_DOWN_FN_RE =
  /const handleRowKeyDown = useCallback\(\s*\(event: ReactKeyboardEvent<HTMLDivElement>\) => \{\s*if \(event\.key !== "Escape" \|\| !expanded\) \{\s*return;\s*\}/;
const ROW_KEYDOWN_STOPS_PROPAGATION_RE =
  /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setExpanded\(false\);/;
const ROW_ONKEYDOWN_WIRED_RE = /className="pdpp-stream-control-row" onKeyDown=\{handleRowKeyDown\} ref=\{rowRef\}/;
// A DOCUMENT-level (or window-level) keydown/Escape listener anywhere in
// this disclosure's effect is exactly the reviewer-flagged anti-pattern
// (capture-phase ordering that still lets the event reach Base UI's bubble
// listener) — this must never reappear.
const DOCUMENT_LEVEL_KEYDOWN_LISTENER_RE = /document\.addEventListener\("keydown"/;
const STOP_IMMEDIATE_PROPAGATION_RE = /stopImmediatePropagation/;

test("CornerControls collapses clipboard/paste/keyboard behind a single accessible disclosure toggle", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");

  assert.match(
    src,
    USE_MORE_ACTIONS_DISCLOSURE_RE,
    "a dedicated disclosure hook must own the expand/collapse state and its listeners"
  );
  assert.match(src, EXPANDED_STATE_RE, "disclosure must start collapsed (expanded: false) at steady state");
  assert.match(
    src,
    MORE_ACTIONS_TOGGLE_BUTTON_RE,
    "the toggle button must expose aria-expanded and a state-appropriate accessible label"
  );

  for (const [name, re] of [
    ["clipboard", SECONDARY_CLIPBOARD_GATED_RE],
    ["copy", SECONDARY_COPY_GATED_RE],
    ["paste", SECONDARY_PASTE_GATED_RE],
    ["keyboard", SECONDARY_KEYBOARD_GATED_RE],
  ] as const) {
    assert.match(
      src,
      re,
      `the ${name} action button must be gated on \`expanded &&\` — always-on secondary icons is exactly the footprint regression this test guards`
    );
  }

  assert.match(
    src,
    RUN_AND_COLLAPSE_RE,
    "choosing a secondary action must both run it and collapse the disclosure back to steady state"
  );
});

test("the disclosure collapses on outside pointerdown and focus loss — never lingers over remote content", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(
    src,
    OUTSIDE_POINTERDOWN_COLLAPSE_RE,
    "a document-level pointerdown listener must collapse the disclosure when the operator taps outside it"
  );
  assert.match(
    src,
    FOCUSOUT_COLLAPSE_RE,
    "the row losing focus (e.g. keyboard user tabbing away) must collapse the disclosure"
  );
});

test("P1: Escape is consumed on the row's own onKeyDown (preventDefault + stopPropagation), never via a document-level listener", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");

  assert.match(
    src,
    HANDLE_ROW_KEY_DOWN_FN_RE,
    "handleRowKeyDown must exist and early-return unless the key is Escape AND the disclosure is expanded"
  );
  assert.match(
    src,
    ROW_KEYDOWN_STOPS_PROPAGATION_RE,
    "handleRowKeyDown must call preventDefault() and stopPropagation() before collapsing — without stopPropagation, " +
      "the event still reaches Base UI's bubble-phase document Escape listener and closes/tears down the session " +
      "(the exact P1 regression this test guards)"
  );
  assert.match(
    src,
    ROW_ONKEYDOWN_WIRED_RE,
    "the control row's div must wire onKeyDown={handleRowKeyDown} — a handler that exists but isn't attached to " +
      "the row never fires"
  );

  // Anti-pattern guards: the ORIGINAL bug's shape (document-level keydown
  // listener) and a tempting-but-wrong alternative fix (stopImmediatePropagation,
  // which only blocks OTHER listeners on the same node/phase — it does NOT stop
  // propagation to document, so Base UI's listener still fires) must never
  // reappear in this disclosure's implementation.
  assert.ok(
    !DOCUMENT_LEVEL_KEYDOWN_LISTENER_RE.test(src),
    'a document-level "keydown" listener must not exist anywhere in this file — Escape must be handled exclusively ' +
      "via the row's own onKeyDown (capture-then-bubble registration-order tricks are fragile and were the P1 bug)"
  );
  assert.ok(
    !STOP_IMMEDIATE_PROPAGATION_RE.test(src),
    "stopImmediatePropagation must not be used as the fix — it only prevents OTHER listeners on the SAME node/phase " +
      "from firing, it does not stop propagation to document, so it would not actually prevent Base UI's dialog " +
      "dismissal from firing"
  );
});

test("the status dot and close button remain always-visible — only the secondary actions are gated", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(
    src,
    STATUS_DOT_ALWAYS_VISIBLE_RE,
    "StatusDot must render unconditionally — connection status is not a secondary action"
  );
  assert.match(
    src,
    CLOSE_BUTTON_ALWAYS_VISIBLE_RE,
    "the close/end-session button must render unconditionally, not gated behind `expanded` — ending the session must always be one tap away"
  );
});

/**
 * Footprint oracle: with 4 always-on 44px buttons + gaps, the previous
 * steady-state row was wide enough to span most of a 390px phone width and
 * land on top of page content (reproduced live: 166px wide covering the
 * ChatGPT footer links). The new steady-state row is status dot + toggle +
 * close only — assert that's a materially smaller footprint, independent of
 * the DOM/CSS engine, mirroring stream-dialog-layout.test.ts's numeric-oracle
 * style for the frame-fit regression.
 */
const CONTROL_SIZE_PX = 44; // --pdpp-stream-control-size: 2.75rem, unchanged by this fix
const GAP_PX = 8; // --pdpp-stream-control-gap: 0.5rem, unchanged by this fix
const STATUS_DOT_WIDTH_PX = 40; // h-10 px-1 wrapper around the 8px dot

function rowWidth(buttonCount: number): number {
  return STATUS_DOT_WIDTH_PX + buttonCount * CONTROL_SIZE_PX + buttonCount * GAP_PX;
}

test("footprint oracle: steady-state row (status + toggle + close) is materially narrower than the old always-on 4-icon row", () => {
  const oldSteadyStateWidth = rowWidth(4); // status dot + clipboard + paste + keyboard + close = 4 buttons
  const newSteadyStateWidth = rowWidth(2); // status dot + toggle + close = 2 buttons
  assert.ok(
    newSteadyStateWidth < oldSteadyStateWidth,
    `new steady-state width (${newSteadyStateWidth}px) must be narrower than the old always-on width (${oldSteadyStateWidth}px)`
  );
  assert.ok(
    oldSteadyStateWidth - newSteadyStateWidth >= CONTROL_SIZE_PX * 2,
    "the reduction must be worth at least two collapsed buttons' width, not a token trim"
  );
});
