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
