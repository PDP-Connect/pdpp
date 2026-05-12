# @demodesk/neko input handling — Android Brave research

Source examined: `/home/user/code/remote-browser-sandbox/client/node_modules/@demodesk/neko/dist/neko.common.js` (28,867 lines, Vue 2 + TypeScript decorator class compiled by Babel) plus `neko.css`.

The component that handles input is `<neko-overlay>` (defined around L26200–27155). Its template (L23886–) creates a `<canvas ref="overlay" class="neko-overlay">` overlaid by a `<textarea ref="textarea" class="neko-overlay" v-model="textInput">`. The textarea is the actual event target — it sits on top of the canvas, has `caret-color: transparent; color: transparent; background: transparent` (neko.css L1) so it's invisible but receives all DOM events.

## 1. Touch handling

There are **two** mutually-exclusive code paths chosen by `onTouchEventsChange` (L26626–26638):

- If `control.supportedTouchEvents` is true (server advertises real X11 touch support), `bindTouchHandler()` is used.
- Otherwise `bindGestureHandler()` is used — a noVNC-derived `GestureHandler` (L25483–) that turns touches into emulated mouse events.

### Native touch path (`bindTouchHandler`, L26391–26447)

Registers listeners on `this._textarea`:

```js
this._textarea.addEventListener('touchstart', this.onTouchHandler, { passive: false });
this._textarea.addEventListener('touchmove',  this.onTouchHandler, { passive: false });
this._textarea.addEventListener('touchend',   this.onTouchHandler, { passive: false });
this._textarea.addEventListener('touchcancel',this.onTouchHandler, { passive: false });
```

`onTouchHandler` (L26415–26447) calls `ev.stopPropagation(); ev.preventDefault();` on every touch event, then iterates `changedTouches` and forwards `control.touchBegin / touchUpdate / touchEnd` with `{touch_id, x, y, pressure}`.

Because `passive: false` and `preventDefault()` are used, the browser's synthesized mouse-after-touch sequence (`mousedown`/`mouseup`/`click`) is suppressed — this is the standard fix for the "double click" bug.

No pointer events are used.

### Gesture path (`GestureHandler`, L25483–25700)

Attaches `touchstart/move/end/cancel` listeners and in `_eventHandler` (L25522–25542) calls `e.stopPropagation(); e.preventDefault();` for every event. It then classifies gestures (onetap / twotap / threetap / longpress / drag / twodrag / pinch) and re-emits them as `gesturestart/move/end` CustomEvents. `onGestureHandler` (L26491–) maps onetap→left click, twotap→right click, threetap→middle click, longpress→right-button-down, etc.

Either way: `preventDefault()` runs on every native touch event, so synthesized mouse events do not fire.

## 2. Soft keyboard / IME input

Keyboard handling uses the bundled **Guacamole keyboard** (L25040–25345) attached via `this.keyboard.listenTo(this._textarea)` (L26352). It registers `keydown`/`keypress`/`keyup` on the textarea and maps them to keysyms.

Critically — and this is the smoking gun for Android — Guacamole's `input` and `compositionend` handlers exist in source but are **explicitly commented out** (L25337–25340):

```js
// Automatically type text entered into the wrapped field
//20220428: NEKO: Removed because of clipboard handling.
//element.addEventListener("input", handleInput, false);
//element.addEventListener("compositionend", handleComposition, false);
```

So @demodesk/neko relies on `keydown.keyCode` + `keydown.key` + legacy `keyIdentifier` (L24247–24283). On Android Chromium soft keyboards (Gboard, Brave's IME), virtual keydowns fire with `keyCode === 229` and `key === "Unidentified"` for most printable characters. Guacamole's `keysym_from_keycode(229)` returns nothing and `key_identifier_sane()` rejects "Unidentified", so the keystroke is dropped.

When `mobileKeyboardShow()` is called (L27093) the textarea is focused to summon the OS keyboard, but there is no `beforeinput`/`input` fallback wired to convert IME text into keystrokes. **This is the same bug Option A has.**

There is a separate clipboard `paste` channel (`control.paste(text)`, L23842–23847 → `CONTROL_PASTE` WS message), but the overlay does not auto-route typed IME text into it.

## 3. Long-press handling

- The textarea has a Vue `@contextmenu` handler (L23919–23923) that calls `$event.stopPropagation(); $event.preventDefault();` and re-emits as `overlay.contextmenu`. Native context menu (including Android long-press menu) is therefore suppressed when contextmenu fires.
- `neko.css` does **not** set `-webkit-touch-callout: none`, `user-select: none`, or `touch-action: none` on the overlay. Searches for these tokens in the bundle/css come up empty.
- The overlay element is a `<textarea>` — on Android Chromium, long-press on a textarea triggers text-selection / "Paste" callout rather than the "Save image" callout that you're hitting on Option A's stream div. The save-image menu specifically requires an `<img>` or canvas drawn long-press target; here the touch target is the textarea (which is empty and transparent).
- However: the absence of `user-select: none` / `-webkit-touch-callout: none` means the **textarea's own selection callout can still appear** on long-press in Android Chromium, even when value is empty, in some versions. This is unverified but a known pitfall.

In the gesture path, longpress is intentionally consumed (mapped to right-click) and `preventDefault()` on touchstart/move/end blocks the gesture that normally triggers the callout, so in practice longpress is handled. the owner's working confirmation on Android Brave is consistent with this.

## 4. VisualViewport reactivity

Yes, partial. `mobileKeyboardShow` (L27093–27103) registers `window.visualViewport.resize` → `onVisualViewportResize` (L27119–27127). The handler does **not** resize the canvas/overlay layout; it only uses the first resize as confirmation that the keyboard opened (`kbdOpen = true`) and a second resize as the close signal so Android can blur the textarea (Android doesn't blur on keyboard dismiss). There is no code that shrinks/recomputes the video element's height to accommodate the OS keyboard — the "black bars" issue would be a layout responsibility of the host page (`.neko-component { width:100%; height:100% }`).

## 5. Wire protocol

It is **not** CDP. `NekoControl` (L23720–23855) sends n.eko's own messages:

- `control.touchBegin/touchUpdate/touchEnd` → `webrtc.send('touchbegin'|'touchupdate'|'touchend', {touch_id,x,y,pressure})` over the data channel, or fallback websocket messages `CONTROL_TOUCHBEGIN/UPDATE/END` (L21100, L23790–23829).
- `control.buttonDown/buttonUp/move/scroll` → `mousedown/mouseup/mousemove/wheel` events.
- `control.keyDown/keyUp` → keysym messages (X11 keysyms via Guacamole).
- `control.paste(text)` → `CONTROL_PASTE {text}`.

Server-side n.eko translates these into XTest / XInput2 events against the X server. The client never speaks CDP.

## 6. `inputMode: "touch"` prop

Consumed in `is_touch_device` getter (L28091–28103):

```js
if (this.inputMode == 'mouse') return false;
if (this.inputMode == 'touch') return true;
return ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
       !window.matchMedia('(pointer:fine)').matches &&
       !window.matchMedia('(hover:hover)').matches;
```

It only short-circuits the heuristic that picks between mouse-mode and touch-mode UI. The actual touch/gesture handler binding is gated on `control.enabledTouchEvents` (toggled by `setTouchEnabled()`, L28413–28417) AND `control.supportedTouchEvents` (reported by server). `inputMode` does not change wire protocol behavior, only which on-screen affordances render.

`setTouchEnabled(true)` flips `state.control.touch.enabled` → `enabledTouchEvents` watcher → `onTouchEventsChange()` binds either the native touch handler or the gesture handler.

---

## Verdict: Partial

**Does @demodesk/neko solve our 5 Android Brave bugs?**

| Bug | Status | Notes |
|---|---|---|
| Double-click (touch + synthesized mouse) | **Solved** | Every touch event has `preventDefault()` at L25525 and L26427 with `passive:false`. Browser suppresses synthesized mouse. |
| Keyboard flicker (focus bouncing) | **Solved** | There is only one focus target — the transparent textarea. No stream div fights for focus. `mobileKeyboardShow()` is an explicit user action. |
| IME `key="Unidentified"` (typed chars dropped) | **NOT solved** | Guacamole `input`/`compositionend` handlers are commented out (L25337–25340). Android Gboard's `keyCode=229 / key="Unidentified"` events are filtered out by `keysym_from_keycode` returning nothing. This is the same root cause as Option A. Upstream fixes typically wire a custom `beforeinput`/`input`→`control.paste()` bridge; n.eko did not. |
| Long-press save-image menu | **Solved in practice** | Touch target is a transparent textarea, not an image/canvas, and `preventDefault()` on touchstart/move/end + `preventDefault()` on `contextmenu` suppress the callout. Matches the owner's working report. |
| Black bars when OS keyboard opens | **Not solved by neko** | The `visualViewport.resize` listener only tracks open/close state for Android blur quirk (L27116–27127). It does not relayout the canvas. The host page using `<neko-overlay>` must handle viewport-aware layout itself. |

### What this means for the architecture choice

If we adopt @demodesk/neko **as-is**, we'd ship:
- Working multi-touch / no double-click / no long-press menu on Android Brave (the hardest bugs in Option A).
- A still-broken Android IME — physical Bluetooth keyboards and desktop browsers work, soft-keyboard typing on Android does not (chars dropped to `Unidentified`).
- Same responsibility we have today to handle viewport / OS-keyboard layout in the parent container.

The IME gap is non-trivial: the sandbox that the owner confirmed working likely either (a) uses a Bluetooth keyboard, (b) types via the n.eko on-screen virtual keyboard component, or (c) routes typing through the `paste()` channel from a separate input affordance. Worth confirming with the sandbox before committing — if Android Gboard typing into a remote `<input>` works in the sandbox demo, there is additional glue we haven't found in the dist bundle.

**Recommendation:** the refactor solves 3/5 bugs definitively and removes the entire hand-rolled CDP touch/mouse layer, which is a big win. But before committing, validate Android Gboard text entry against the actual sandbox — if it's broken, we'd still need a custom `beforeinput`-to-`control.paste` shim on top of @demodesk/neko, which is a much smaller addition than rebuilding all touch handling but should be in scope of the migration plan.
