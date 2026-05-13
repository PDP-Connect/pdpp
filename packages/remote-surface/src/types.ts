// Public types for the RemoteSurface abstraction.
//
// Shape follows §37-49 of docs/5-12-26-chatgpt-remote-surface-brief-response.txt:
// a thin interaction-forwarding surface, intentionally narrower than a
// general-purpose remote-desktop API. Concrete adapters (n.eko, CDP) translate
// these events into their respective transports.

/**
 * Pointer event forwarded to the remote surface. Mirrors the subset of
 * PointerEvent fields adapters need to reconstruct a synthetic input on
 * the remote side. Coordinates are in remote-viewport pixels (adapters
 * are responsible for any local→remote scaling).
 */
export type RemotePointerEvent = {
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  x: number;
  y: number;
  pointerType: "mouse" | "touch" | "pen";
  pointerId: number;
  button?: number;
  pressure?: number;
};

/**
 * Keyboard event forwarded as an X11 keysym (the canonical wire format
 * used by Guacamole and n.eko). Adapters that need browser KeyboardEvent
 * objects must convert at the boundary.
 */
export type RemoteKeysymEvent = {
  type: "keydown" | "keyup";
  keysym: number;
};

/**
 * Discriminated config envelope. Concrete adapters narrow on `kind` and
 * cast to their adapter-specific config shape. Kept opaque at this layer
 * to avoid leaking transport details (signaling URLs, CDP targets, etc.)
 * into consumer code.
 */
export type RemoteSurfaceConfig =
  | ({ kind: "neko" } & Record<string, unknown>)
  | ({ kind: "cdp" } & Record<string, unknown>);

export type RemoteSurfaceLifecycleState =
  | "idle"
  | "mounting"
  | "mounted"
  | "unmounting"
  | "error";

/**
 * Optional hints for focusing the remote text-input path. `inputMode`
 * lets the local mobile IME pick an appropriate on-screen keyboard
 * layout without leaking PDPP-specific semantics to the remote side.
 */
export type FocusTextInputOptions = {
  inputMode?: "text" | "email" | "numeric" | "password";
};

export interface RemoteSurface {
  mount(el: HTMLElement): Promise<void>;
  unmount(): Promise<void>;
  focusTextInput(opts?: FocusTextInputOptions): void;
  blurTextInput(): void;
  setRemoteInputFocused(focused: boolean): void;
  sendPointer(event: RemotePointerEvent): Promise<void>;
  sendKeysym(event: RemoteKeysymEvent): Promise<void>;
  sendText(text: string): Promise<void>;
  pasteText(text: string): Promise<boolean>;
  copyRemoteSelection(): Promise<boolean>;
}
