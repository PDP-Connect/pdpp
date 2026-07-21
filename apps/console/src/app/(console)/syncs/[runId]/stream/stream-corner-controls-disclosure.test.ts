import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const STREAM_VIEWER_FILE = `${HERE}stream-viewer.tsx`;

/**
 * Static structure guard only. The behavioral contract (steady state hides
 * secondary actions, first Escape collapses without closing the dialog,
 * second Escape closes normally, outside-pointer/focus collapse) is proved
 * by `scripts/manual-action-stream-smoke.mjs`'s `assertCornerControlsDisclosure`
 * against a real Base UI dialog — this file only guards that the pieces that
 * behavior depends on still exist in source.
 */

const EXPANDED_STATE_RE = /const \[expanded, setExpanded\] = useState\(false\)/;
const SECONDARY_ACTIONS_GATED_RE = /\{expanded && on(Clipboard|Copy|Paste|Keyboard) \?/g;
const WINDOW_CAPTURE_ESCAPE_RE = /window\.addEventListener\("keydown", handleWindowKeyDown, true\)/;
const CLOSE_BUTTON_UNGATED_RE =
  /aria-label=\{`End \$\{connectorName\} browser session`\}[\s\S]{0,40}className="pdpp-stream-control-button"/;

test("CornerControls disclosure structure: collapsed state, gated secondary actions, window-capture Escape, ungated close", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");

  assert.match(src, EXPANDED_STATE_RE, "disclosure must start collapsed");
  assert.equal(
    [...src.matchAll(SECONDARY_ACTIONS_GATED_RE)].length,
    4,
    "all four secondary actions (clipboard/copy/paste/keyboard) must be gated on `expanded &&`"
  );
  assert.match(
    src,
    WINDOW_CAPTURE_ESCAPE_RE,
    "Escape must be handled via a window-level capture listener, not a row-scoped or document-level one"
  );
  assert.match(
    src,
    CLOSE_BUTTON_UNGATED_RE,
    "the close/end-session button must render unconditionally — never gated behind `expanded`"
  );
});
