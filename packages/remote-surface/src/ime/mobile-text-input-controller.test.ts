// Tests for MobileTextInputController.
//
// The package's runtime expects browser DOM; the test environment is
// node:test without jsdom. We use a minimal EventTarget-based textarea
// stub that captures enough behaviour for the controller's listeners.
// This mirrors the no-DOM-runtime style already used by
// neko-pointer-controller.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MobileTextInputController,
  XK_BackSpace,
  XK_Delete,
  XK_Return,
  XK_Up,
} from "./mobile-text-input-controller.ts";

// ── Minimal HTMLTextAreaElement stub ──────────────────────────────────

class StubTextarea extends EventTarget {
  value = "";
  setSelectionRange(_start: number, _end: number): void {
    /* no-op for tests */
  }
}

function makeStub(): HTMLTextAreaElement {
  return new StubTextarea() as unknown as HTMLTextAreaElement;
}

// Minimal InputEvent shape. Real browsers' InputEvent has `inputType` and
// `data`; node has neither natively. CustomEvent-like dispatch via plain
// Event with extra props is sufficient because the controller only reads
// `.inputType` / `.data`.
function makeInputEvent(
  inputType: string,
  data: string | null,
  options: { isComposing?: boolean } = {},
): Event {
  const e = new Event("input") as unknown as Record<string, unknown>;
  e.inputType = inputType;
  e.data = data;
  e.isComposing = options.isComposing ?? false;
  return e as unknown as Event;
}

function makeCompositionEvent(type: string, data: string): Event {
  const e = new Event(type) as unknown as Record<string, unknown>;
  e.data = data;
  return e as unknown as Event;
}

function makeKeydownEvent(key: string): Event {
  const e = new Event("keydown") as unknown as Record<string, unknown>;
  e.key = key;
  e.preventDefault = () => {
    /* no-op */
  };
  return e as unknown as Event;
}

interface Captured {
  commits: string[];
  keysyms: number[];
}

function bind(textarea: HTMLTextAreaElement): {
  controller: MobileTextInputController;
  captured: Captured;
} {
  const captured: Captured = { commits: [], keysyms: [] };
  const controller = new MobileTextInputController({
    textarea,
    onTextCommit: (t) => captured.commits.push(t),
    onSpecialKey: (k) => captured.keysyms.push(k),
  });
  return { controller, captured };
}

describe("MobileTextInputController", () => {
  it("composition flow: compositionstart → compositionend commits once", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(new Event("compositionstart"));
    // Composing inputs should be suppressed
    ta.dispatchEvent(makeInputEvent("insertCompositionText", "h", { isComposing: true }));
    ta.dispatchEvent(makeInputEvent("insertCompositionText", "he", { isComposing: true }));
    ta.dispatchEvent(makeCompositionEvent("compositionend", "hello"));
    assert.deepEqual(captured.commits, ["hello"]);
    assert.deepEqual(captured.keysyms, []);
  });

  it("non-composing insertText commits each character", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("insertText", "h"));
    ta.dispatchEvent(makeInputEvent("insertText", "i"));
    assert.deepEqual(captured.commits, ["h", "i"]);
  });

  it("deleteContentBackward emits XK_BackSpace", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("deleteContentBackward", null));
    assert.deepEqual(captured.keysyms, [XK_BackSpace]);
    assert.deepEqual(captured.commits, []);
  });

  it("deleteContentForward emits XK_Delete", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("deleteContentForward", null));
    assert.deepEqual(captured.keysyms, [XK_Delete]);
  });

  it("insertLineBreak emits XK_Return", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("insertLineBreak", null));
    assert.deepEqual(captured.keysyms, [XK_Return]);
  });

  it("ArrowUp keydown emits XK_Up", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeKeydownEvent("ArrowUp"));
    assert.deepEqual(captured.keysyms, [XK_Up]);
  });

  it("letter keydown does NOT emit (handled via input event path)", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeKeydownEvent("a"));
    ta.dispatchEvent(makeKeydownEvent("Unidentified"));
    assert.deepEqual(captured.keysyms, []);
    assert.deepEqual(captured.commits, []);
  });

  it("autocomplete tap (insertReplacementText) commits the replacement", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("insertReplacementText", "hello"));
    assert.deepEqual(captured.commits, ["hello"]);
  });

  it("unknown inputType falls back to data when present", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("someVendorSpecific", "x"));
    assert.deepEqual(captured.commits, ["x"]);
  });

  it("unknown inputType with no data is a no-op (logged only)", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(makeInputEvent("someVendorSpecific", null));
    assert.deepEqual(captured.commits, []);
    assert.deepEqual(captured.keysyms, []);
  });

  it("disposed controller ignores subsequent events", () => {
    const ta = makeStub();
    const { controller, captured } = bind(ta);
    controller.dispose();
    ta.dispatchEvent(makeInputEvent("insertText", "z"));
    ta.dispatchEvent(makeCompositionEvent("compositionend", "abc"));
    ta.dispatchEvent(makeKeydownEvent("ArrowUp"));
    assert.deepEqual(captured.commits, []);
    assert.deepEqual(captured.keysyms, []);
  });

  it("dispose is idempotent", () => {
    const ta = makeStub();
    const { controller } = bind(ta);
    controller.dispose();
    controller.dispose();
    /* no throw */
  });

  it("resets textarea to empty after each emission (step-5 ruling 3)", () => {
    const ta = makeStub();
    bind(ta);
    // Ruling 3: empty baseline — no sentinel padding.
    assert.equal(ta.value, "", "expected empty textarea after construct");
    ta.value = "garbage";
    ta.dispatchEvent(makeInputEvent("insertText", "h"));
    assert.equal(ta.value, "", "expected reset to empty after emission");
  });

  it("compositionend with empty data is a no-op for onTextCommit", () => {
    const ta = makeStub();
    const { captured } = bind(ta);
    ta.dispatchEvent(new Event("compositionstart"));
    ta.dispatchEvent(makeCompositionEvent("compositionend", ""));
    assert.deepEqual(captured.commits, []);
  });
});
