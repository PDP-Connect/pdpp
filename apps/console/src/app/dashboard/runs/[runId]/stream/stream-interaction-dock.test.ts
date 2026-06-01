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
