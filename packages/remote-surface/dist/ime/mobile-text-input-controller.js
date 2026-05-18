// MobileTextInputController — Guacamole-style hidden-textarea bridge for
// mobile IMEs (Android Gboard, iOS QuickType, SwiftKey).
//
// ## Step-5 expert ruling 3: no sentinel padding (commit-only path)
//
// Earlier drafts seeded the textarea with U+200B zero-width-space padding
// on both sides of the caret, copying Guacamole's full diff algorithm. For
// the **commit-only** path we actually take (compositionend + InputEvent.data
// → keysym/text), the padding is dead weight: we don't diff the textarea
// against a baseline, we just read `event.data`. Padding also confuses some
// Android keyboards' suggestion bars (they see a nonsense prefix).
//
// What we do now:
//   - Textarea starts empty ("").
//   - After every commit/special-key we clear with `textarea.value = ""`.
//   - No setSelectionRange between sentinels.
//
// If we later need full CJK / IME-diff parity (Cangjie, marked-text
// continuations, autocorrect rewriting the middle of a word), the right
// move per the expert is a **separate** `DiffTextInputController` that
// keeps a baseline + prefix/suffix diff. Do NOT bolt that back onto this
// commit-only controller — the two strategies have different invariants
// (this one trusts InputEvent.data; the diff one trusts the buffer).
//
// ## Verified pattern (3 sources)
//
// 1. Apache Guacamole `guacTextInput.js` + `Keyboard.js`. Canonical
//    architecture: hidden textarea, sentinel padding, `compositionstart/end`
//    bracketing, diff committed text vs sentinel baseline, emit X11
//    keysyms. See docs/mobile-ime-prior-art-research.md §"Priority 3".
//
// 2. `@demodesk/neko` bundled Guacamole keyboard
//    (~/code/remote-browser-sandbox/client/node_modules/@demodesk/neko/dist/neko.common.js
//    L25299-25334). Confirms the simpler "commit-only" subset we adopt:
//      - `input` event: when `e.data && !e.isComposing`, type `e.data`.
//        Detach `compositionend` to avoid double-fire.
//      - `compositionend` event: when `e.data`, type `e.data`. Detach
//        `input` to avoid double-fire.
//    The demodesk lines are commented out in their build for clipboard
//    reasons (their concern, not ours); the *pattern* is the reference.
//
// 3. Wayland `input-method-unstable-v1` (cited in prior-art doc): protocol
//    separates `commit_string` (final IME output, the only safe channel for
//    keysym synthesis) from `forward_key` (raw keys). Confirms: never
//    synthesize keysyms from composing text — only from the committed
//    string.
//
// ## What we adopt vs. what we skip
//
// ADOPT (Guacamole "text-input mode" subset):
//   - Hidden textarea, starts empty (no sentinel padding — see ruling 3
//     in the file header).
//   - compositionstart sets `composing = true`; suppress `input` emission.
//   - compositionend fires `onTextCommit(e.data)`.
//   - Non-composing `input` events: `insertText` / `insertReplacementText`
//     / `insertCompositionText` → `onTextCommit(e.data)`.
//   - `deleteContentBackward` → `onSpecialKey(XK_BackSpace)`.
//   - `insertLineBreak` → `onSpecialKey(XK_Return)`.
//   - `keydown` for non-text special keys (Tab, Escape, Arrows, F-keys,
//     PageUp/Down, Home, End, Delete) → `onSpecialKey(keysym)`. Letters
//     are NOT dispatched here — they arrive via `input` and double-firing
//     would corrupt IME composition (per Guacamole and Wayland docs).
//   - Reset textarea to empty after each emission so the next input
//     starts from a known state.
//
// SKIP for first ship (acceptable for English/numeric/email/password/2FA
// flows; would need extending for full CJK/diff parity):
//   - Full prefix/suffix diff algorithm. We rely on InputEvent.data for
//     commits, which Chromium-on-Android fills correctly for Gboard,
//     SwiftKey, and predictive replacement. This is the same shortcut
//     `~/code/remote-browser-sandbox/client/src/input.ts:244-255` takes.
//   - Modifier-chord support (Ctrl-C etc). Out of scope for soft keyboards;
//     desktop keyboards already go via the existing neko keydown path.
// X11 keysym constants. Values from
// https://gitlab.freedesktop.org/xorg/proto/xorgproto/-/blob/master/include/X11/keysymdef.h
// (Guacamole's Keyboard.js uses the same numeric values).
export const XK_BackSpace = 0xff08;
export const XK_Tab = 0xff09;
export const XK_Return = 0xff0d;
export const XK_Escape = 0xff1b;
export const XK_Delete = 0xffff;
export const XK_Home = 0xff50;
export const XK_Left = 0xff51;
export const XK_Up = 0xff52;
export const XK_Right = 0xff53;
export const XK_Down = 0xff54;
export const XK_PageUp = 0xff55;
export const XK_PageDown = 0xff56;
export const XK_End = 0xff57;
const KEY_TO_KEYSYM = {
    Tab: XK_Tab,
    Escape: XK_Escape,
    Delete: XK_Delete,
    Home: XK_Home,
    End: XK_End,
    PageUp: XK_PageUp,
    PageDown: XK_PageDown,
    ArrowUp: XK_Up,
    ArrowDown: XK_Down,
    ArrowLeft: XK_Left,
    ArrowRight: XK_Right,
    // F1-F12: keysym 0xFFBE + (n-1). Generated below.
};
for (let n = 1; n <= 12; n += 1) {
    KEY_TO_KEYSYM[`F${n}`] = 0xffbe + (n - 1);
}
const noopLogger = () => {
    /* no-op */
};
const DEFAULT_KEYDOWN_FALLBACK_DELAY_MS = 40;
export class MobileTextInputController {
    textarea;
    onTextCommit;
    onSpecialKey;
    log;
    keydownFallbackDelayMs;
    composing = false;
    disposed = false;
    pendingKeydownFallbackTimers = new Set();
    // Bound listener refs so removeEventListener works.
    listeners = [];
    constructor(deps) {
        this.textarea = deps.textarea;
        this.onTextCommit = deps.onTextCommit;
        this.onSpecialKey = deps.onSpecialKey;
        this.log = deps.logger ?? noopLogger;
        this.keydownFallbackDelayMs =
            deps.keydownFallbackDelayMs ?? DEFAULT_KEYDOWN_FALLBACK_DELAY_MS;
        this.resetTextarea();
        this.attach();
        this.log("info", "mobile-text-input.attached", {
            tagName: this.textarea.tagName,
        });
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const { type, fn } of this.listeners) {
            this.textarea.removeEventListener(type, fn);
        }
        this.listeners.length = 0;
        this.cancelPendingKeydownFallback("dispose");
    }
    /** Test/inspection hook. */
    isComposing() {
        return this.composing;
    }
    resetTextarea() {
        // Ruling 3: empty baseline — no sentinel padding. See file header.
        this.textarea.value = "";
    }
    cancelPendingKeydownFallback(reason) {
        if (this.pendingKeydownFallbackTimers.size === 0) {
            return;
        }
        for (const timer of this.pendingKeydownFallbackTimers) {
            clearTimeout(timer);
        }
        const cancelledCount = this.pendingKeydownFallbackTimers.size;
        this.pendingKeydownFallbackTimers.clear();
        this.log("debug", "mobile-text-input.keydown-fallback.cancelled", {
            cancelledCount,
            reason,
        });
    }
    scheduleKeydownFallback(key) {
        const timer = setTimeout(() => {
            if (!this.pendingKeydownFallbackTimers.delete(timer)) {
                return;
            }
            if (this.disposed || this.composing) {
                return;
            }
            this.log("info", "mobile-text-input.keydown-fallback.commit", {
                textLength: key.length,
            });
            this.onTextCommit(key);
            this.resetTextarea();
        }, this.keydownFallbackDelayMs);
        this.pendingKeydownFallbackTimers.add(timer);
        this.log("debug", "mobile-text-input.keydown-fallback.scheduled", {
            textLength: key.length,
        });
    }
    isPrintableFallbackKey(e) {
        if (this.composing ||
            e.isComposing ||
            e.altKey ||
            e.ctrlKey ||
            e.metaKey ||
            e.key.length !== 1) {
            return false;
        }
        return true;
    }
    attach() {
        const add = (type, fn) => {
            this.textarea.addEventListener(type, fn);
            this.listeners.push({ type, fn });
        };
        add("compositionstart", () => {
            if (this.disposed) {
                return;
            }
            this.cancelPendingKeydownFallback("compositionstart");
            this.composing = true;
        });
        add("compositionend", (ev) => {
            if (this.disposed) {
                return;
            }
            this.cancelPendingKeydownFallback("compositionend");
            this.composing = false;
            const data = ev.data ?? "";
            if (data.length > 0) {
                this.onTextCommit(data);
            }
            this.resetTextarea();
        });
        add("beforeinput", () => {
            if (this.disposed) {
                return;
            }
            this.cancelPendingKeydownFallback("beforeinput");
        });
        add("input", (ev) => {
            if (this.disposed) {
                return;
            }
            this.cancelPendingKeydownFallback("input");
            // While composing, suppress per-keystroke emission; compositionend
            // will deliver the final committed string.
            if (this.composing) {
                return;
            }
            const e = ev;
            const inputType = e.inputType ?? "";
            const data = e.data ?? "";
            switch (inputType) {
                case "insertText":
                case "insertReplacementText":
                case "insertCompositionText":
                case "insertFromComposition":
                case "insertFromPaste":
                case "insertFromAutoComplete":
                    if (data.length > 0) {
                        this.onTextCommit(data);
                    }
                    break;
                case "deleteContentBackward":
                case "deleteWordBackward":
                case "deleteSoftLineBackward":
                case "deleteHardLineBackward":
                    this.onSpecialKey(XK_BackSpace);
                    break;
                case "deleteContentForward":
                case "deleteWordForward":
                    this.onSpecialKey(XK_Delete);
                    break;
                case "insertLineBreak":
                case "insertParagraph":
                    this.onSpecialKey(XK_Return);
                    break;
                default:
                    this.log("debug", "mobile-text-input.unhandled-input-type", {
                        inputType,
                        hasData: data.length > 0,
                    });
                    // Fall back to data if present — many Android keyboards report
                    // non-standard inputTypes but still populate `data`.
                    if (data.length > 0) {
                        this.onTextCommit(data);
                    }
            }
            // Reset to empty so repeated taps don't accumulate in the textarea.
            this.resetTextarea();
        });
        add("keydown", (ev) => {
            if (this.disposed) {
                return;
            }
            const e = ev;
            const keysym = KEY_TO_KEYSYM[e.key];
            if (keysym == null) {
                // Letters, digits, symbols: handled by `input` event. Do NOT
                // double-emit. If a browser/automation path focuses the hidden
                // textarea but fails to deliver beforeinput/input, schedule a short
                // fallback commit that the primary text events cancel.
                if (this.isPrintableFallbackKey(e)) {
                    this.scheduleKeydownFallback(e.key);
                }
                return;
            }
            // Special key — prevent the textarea from acting on it locally
            // (e.g. don't actually navigate selection on ArrowLeft) and forward.
            e.preventDefault();
            this.onSpecialKey(keysym);
        });
    }
}
//# sourceMappingURL=mobile-text-input-controller.js.map