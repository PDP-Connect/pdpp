import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RemoteSurfaceFormFieldRect } from "../../protocol/index.ts";
import {
  createFormOverlayReconciliationState,
  formFieldToControlHint,
  formFieldToOverlayRect,
  planFormOverlaySpecialKeyCommit,
  planFormOverlayValueCommit,
  reconcileFormOverlayFields,
  type FormOverlayFieldState,
} from "./index.ts";

function field(overrides: Partial<RemoteSurfaceFormFieldRect> = {}): RemoteSurfaceFormFieldRect {
  return {
    tag: "input",
    inputType: "text",
    placeholder: "",
    name: "email",
    id: "",
    x: 20,
    y: 30,
    width: 200,
    height: 40,
    value: "",
    focused: false,
    ...overrides,
  };
}

function fieldState(overrides: Partial<RemoteSurfaceFormFieldRect> = {}): FormOverlayFieldState {
  return {
    field: field(overrides),
    identityKey: "name:input:text:email",
    lastSeenSequence: 1,
    overlayId: "field-1",
  };
}

describe("form overlay geometry", () => {
  it("maps remote field rectangles through contained stream geometry", () => {
    assert.deepEqual(
      formFieldToOverlayRect({
        field: field({ x: 100, y: 200, width: 80, height: 40 }),
        imageBox: { left: 0, top: 0, width: 1000, height: 500 },
        viewport: { width: 400, height: 800 },
      }),
      {
        left: 437.5,
        top: 125,
        width: 50,
        height: 25,
      },
    );
  });

  it("clips partially visible remote fields and drops fully out-of-view fields", () => {
    assert.deepEqual(
      formFieldToOverlayRect({
        field: field({ x: -20, y: 10, width: 60, height: 20 }),
        imageBox: { left: 10, top: 20, width: 400, height: 800 },
        viewport: { width: 400, height: 800 },
      }),
      {
        left: 10,
        top: 30,
        width: 40,
        height: 20,
      },
    );
    assert.equal(
      formFieldToOverlayRect({
        field: field({ x: 401, y: 10, width: 60, height: 20 }),
        imageBox: { left: 10, top: 20, width: 400, height: 800 },
        viewport: { width: 400, height: 800 },
      }),
      null,
    );
  });
});

describe("form overlay reconciliation", () => {
  it("preserves stable identity for named fields that move", () => {
    const first = reconcileFormOverlayFields(createFormOverlayReconciliationState(), [field()]);
    const second = reconcileFormOverlayFields(first.state, [field({ x: 90, y: 120 })]);

    assert.deepEqual(second.state.entries.map((entry) => entry.overlayId), ["field-1"]);
    assert.deepEqual(second.changes, [
      {
        type: "moved",
        overlayId: "field-1",
        field: field({ x: 90, y: 120 }),
        previous: field(),
      },
    ]);
  });

  it("tolerates stale rectangle jitter without reporting churn", () => {
    const first = reconcileFormOverlayFields(createFormOverlayReconciliationState(), [field()]);
    const second = reconcileFormOverlayFields(first.state, [field({ x: 22, y: 31, width: 201, height: 39 })]);

    assert.deepEqual(second.state.entries.map((entry) => entry.overlayId), ["field-1"]);
    assert.deepEqual(second.changes, []);
  });

  it("reuses anonymous field identity when the rect changes within tolerance", () => {
    const anonymous = field({ name: "", x: 20, y: 30 });
    const first = reconcileFormOverlayFields(createFormOverlayReconciliationState(), [anonymous]);
    const second = reconcileFormOverlayFields(first.state, [field({ name: "", x: 23, y: 27 })]);

    assert.deepEqual(second.state.entries.map((entry) => entry.overlayId), ["field-1"]);
    assert.deepEqual(second.changes, []);
  });

  it("reports disappeared fields", () => {
    const first = reconcileFormOverlayFields(createFormOverlayReconciliationState(), [field()]);
    const second = reconcileFormOverlayFields(first.state, []);

    assert.deepEqual(second.changes, [{ type: "disappeared", overlayId: "field-1", field: field() }]);
    assert.deepEqual(second.state.entries, []);
  });
});

describe("form overlay control hints", () => {
  it("marks password fields for current-password autofill", () => {
    assert.deepEqual(formFieldToControlHint(field({ inputType: "password" })), {
      autocomplete: "current-password",
      disabled: false,
      element: "input",
      inputType: "password",
      password: true,
      readOnly: false,
    });
  });

  it("renders textarea, select, and contenteditable as native textarea/input hints only", () => {
    assert.deepEqual(formFieldToControlHint(field({ tag: "textarea", inputType: "" })).element, "textarea");
    assert.deepEqual(formFieldToControlHint(field({ tag: "select", inputType: "" })).element, "input");
    assert.deepEqual(formFieldToControlHint(field({ tag: "contenteditable", inputType: "" })).element, "input");
  });
});

describe("form overlay commit planning", () => {
  it("commits appended text with focus and insertText", () => {
    assert.deepEqual(
      planFormOverlayValueCommit({
        previousValue: "tim",
        currentValue: "tim@example.test",
        fieldState: fieldState({ focused: false }),
      }),
      {
        status: "committed",
        operations: [
          { type: "focus_field", overlayId: "field-1", field: field({ focused: false }) },
          { type: "insert_text", text: "@example.test" },
        ],
      },
    );
  });

  it("commits end deletions as Backspace key presses", () => {
    assert.deepEqual(
      planFormOverlayValueCommit({
        previousValue: "hello",
        currentValue: "hel",
        fieldState: fieldState({ focused: true }),
      }),
      {
        status: "committed",
        operations: [
          { type: "key_press", key: "Backspace", code: "Backspace", modifiers: [] },
          { type: "key_press", key: "Backspace", code: "Backspace", modifiers: [] },
        ],
      },
    );
  });

  it("uses one select-all replacement path for paste, autofill, and middle edits", () => {
    assert.deepEqual(
      planFormOverlayValueCommit({
        previousValue: "hello",
        currentValue: "heLlo",
        fieldState: fieldState({ focused: true }),
      }),
      {
        status: "committed",
        operations: [{ type: "select_all" }, { type: "insert_text", text: "heLlo" }],
      },
    );
  });

  it("uses explicit clear for full deletion", () => {
    assert.deepEqual(
      planFormOverlayValueCommit({
        previousValue: "secret",
        currentValue: "",
        fieldState: fieldState({ focused: true, inputType: "password" }),
      }),
      {
        status: "committed",
        operations: [{ type: "select_all" }, { type: "clear" }],
      },
    );
  });

  it("defers value and special-key commits while IME composition is active", () => {
    assert.deepEqual(
      planFormOverlayValueCommit({
        previousValue: "",
        currentValue: "あ",
        fieldState: fieldState(),
        isComposing: true,
      }),
      { status: "deferred", operations: [{ type: "defer", reason: "composition_active" }] },
    );
    assert.deepEqual(
      planFormOverlaySpecialKeyCommit({ key: "Enter", fieldState: fieldState(), isComposing: true }),
      { status: "deferred", operations: [{ type: "defer", reason: "composition_active" }] },
    );
  });

  it("submits Enter and Tab semantically", () => {
    assert.deepEqual(
      planFormOverlaySpecialKeyCommit({
        key: "Enter",
        code: "Enter",
        modifiers: ["Shift"],
        fieldState: fieldState({ focused: true }),
      }),
      {
        status: "committed",
        operations: [{ type: "submit", key: "Enter", code: "Enter", modifiers: ["Shift"] }],
      },
    );
    assert.deepEqual(
      planFormOverlaySpecialKeyCommit({ key: "Tab", fieldState: fieldState({ focused: true }) }).operations,
      [{ type: "submit", key: "Tab", code: "Tab", modifiers: [] }],
    );
  });

  it("ignores mobile IME process keys and avoids remote focus when already focused", () => {
    assert.deepEqual(planFormOverlaySpecialKeyCommit({ key: "Process", fieldState: fieldState() }), {
      status: "noop",
      operations: [],
    });
    assert.deepEqual(
      planFormOverlayValueCommit({
        previousValue: "",
        currentValue: "x",
        fieldState: fieldState({ focused: true }),
      }),
      { status: "committed", operations: [{ type: "insert_text", text: "x" }] },
    );
  });
});
