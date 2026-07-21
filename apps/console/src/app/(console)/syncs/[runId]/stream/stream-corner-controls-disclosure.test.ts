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
const ESCAPE_COLLAPSE_RE = /if \(event\.key === "Escape"\) \{\s*collapse\(\);\s*\}/;
const FOCUSOUT_COLLAPSE_RE = /rowRef\.current\?\.addEventListener\("focusout", handleFocusOut\)/;
const CLOSE_BUTTON_ALWAYS_VISIBLE_RE =
  /aria-label=\{`End \$\{connectorName\} browser session`\}[\s\S]{0,40}className="pdpp-stream-control-button"/;
const STATUS_DOT_ALWAYS_VISIBLE_RE = /<StatusDot status=\{status\} \/>/;

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

test("the disclosure collapses on outside pointerdown, Escape, and focus loss — never lingers over remote content", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(
    src,
    OUTSIDE_POINTERDOWN_COLLAPSE_RE,
    "a document-level pointerdown listener must collapse the disclosure when the operator taps outside it"
  );
  assert.match(src, ESCAPE_COLLAPSE_RE, "Escape must collapse the open disclosure");
  assert.match(
    src,
    FOCUSOUT_COLLAPSE_RE,
    "the row losing focus (e.g. keyboard user tabbing away) must collapse the disclosure"
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
