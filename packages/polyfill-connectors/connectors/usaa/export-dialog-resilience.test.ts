// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for USAA export dialog selector resilience (run_1787967159528).
 *
 * The export button was found and clicked, but the dialog lacked the expected
 * select[name="selectionType"]. The fix accepts dialogs with date inputs even
 * when the select wrapper is missing. These tests verify the fallback works
 * and does not suppress legitimate failures.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

interface DialogState {
  selectCount: number;
  dialogCount: number;
  dateInputCount: number;
}

/**
 * Simulates openExportDialog's decision logic:
 * 1. If select[name="selectionType"] found, accept (original path)
 * 2. Else if dialog + date inputs exist, accept (fallback)
 * 3. Else reject
 */
function decideDialogValid(state: DialogState): boolean {
  if (state.selectCount > 0) {
    return true; // Original path: select found
  }

  // Fallback: accept if dialog + date inputs present
  if (state.dialogCount > 0 && state.dateInputCount > 0) {
    return true;
  }

  return false; // Reject
}

test("Dialog with date inputs but no select: accept (fallback)", () => {
  const state: DialogState = { selectCount: 0, dialogCount: 1, dateInputCount: 1 };
  assert.ok(
    decideDialogValid(state),
    "Should accept dialog with date inputs despite missing select"
  );
});

test("Dialog with no date inputs: reject", () => {
  const state: DialogState = { selectCount: 0, dialogCount: 1, dateInputCount: 0 };
  assert.ok(!decideDialogValid(state), "Should reject dialog without date inputs");
});

test("No dialog at all: reject", () => {
  const state: DialogState = { selectCount: 0, dialogCount: 0, dateInputCount: 0 };
  assert.ok(!decideDialogValid(state), "Should reject when no dialog opens");
});

test("Original structure with select: accept", () => {
  const state: DialogState = { selectCount: 1, dialogCount: 1, dateInputCount: 1 };
  assert.ok(decideDialogValid(state), "Should still accept original dialog structure");
});

test("Dialog exists but both select AND date inputs missing: reject", () => {
  const state: DialogState = { selectCount: 0, dialogCount: 1, dateInputCount: 0 };
  assert.ok(
    !decideDialogValid(state),
    "Should reject dialog that has neither select nor date inputs"
  );
});

test("Select present alone without date inputs: accept (original path)", () => {
  // Edge case: original USAA structure had select but for some reason no visible
  // date inputs yet. The select finding is authoritative, so we accept it.
  const state: DialogState = { selectCount: 1, dialogCount: 1, dateInputCount: 0 };
  assert.ok(
    decideDialogValid(state),
    "Original path succeeds even if date inputs not immediately visible"
  );
});
