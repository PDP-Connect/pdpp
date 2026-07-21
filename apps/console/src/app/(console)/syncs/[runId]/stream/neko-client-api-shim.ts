// NekoClientApi shim — adapts the file-level neko-client.ts module exports
// into the structural `NekoClientApi` interface the @opendatalabs/remote-surface
// NekoSurfaceAdapter expects.
//
// This is the *only* place where the dashboard reaches into neko-client.ts
// for adapter-relevant helpers. Step 3 of the RemoteSurface migration; see
// docs/remote-surface-step-3-dashboard-wire.md.

import type { NekoClientApi, NekoPointerControl } from "@opendatalabs/remote-surface/client";
import type { RemoteSurfaceInputPayload } from "@opendatalabs/remote-surface/protocol";

import {
  blurNekoKeyboard,
  copyRemoteSelectionFromNeko,
  dispatchNekoKeysymForAdapter,
  focusNekoKeyboard,
  getNekoPointerControlForAdapter,
  mapNekoPointerToRemoteForAdapter,
  type NekoClientConfig,
  pasteTextIntoNeko,
  setNekoRemoteInputFocused,
  startNeko,
  stopNeko,
} from "./neko-client";

/**
 * Construct a NekoClientApi bound to the module-singleton neko-client.ts
 * state. There is exactly one live n.eko instance per page; the adapter's
 * lifecycle (mount/unmount) drives the underlying `startNeko`/`stopNeko`
 * pair.
 *
 * Caller owns the mount-container reference (we capture it on `start` so
 * `stop` can pass it back). Caller also owns the soft-keyboard textarea
 * ref (passed via `getTextarea`) — the adapter binds
 * MobileTextInputController to it lazily.
 */
export function createNekoClientApi(opts?: {
  dispatchInput?: (intent: Extract<RemoteSurfaceInputPayload, { type: "pointer" }>) => void;
  getTextarea?: () => HTMLTextAreaElement | null;
}): NekoClientApi {
  let mountedContainer: HTMLElement | null = null;

  return {
    async start(container: HTMLElement, config: unknown): Promise<void> {
      mountedContainer = container;
      // The dashboard always passes a fully-typed NekoClientConfig; the
      // adapter's `unknown` is just to avoid leaking apps/console types into
      // the package.
      await startNeko(container, config as NekoClientConfig, { dispatchInput: opts?.dispatchInput });
    },
    stop(): void {
      if (mountedContainer) {
        stopNeko(mountedContainer);
        mountedContainer = null;
      }
    },
    focusKeyboard(): void {
      focusNekoKeyboard();
    },
    blurKeyboard(): void {
      blurNekoKeyboard();
    },
    setRemoteInputFocused(focused: boolean): void {
      setNekoRemoteInputFocused(focused);
    },
    sendText(text: string): boolean {
      return pasteTextIntoNeko(text, { focusKeyboardAfterPaste: false });
    },
    pasteText(text: string): boolean {
      return pasteTextIntoNeko(text);
    },
    copyRemoteSelection(): boolean {
      return copyRemoteSelectionFromNeko();
    },
    getPointerControl(): NekoPointerControl | null {
      const control = getNekoPointerControlForAdapter();
      if (
        !control ||
        typeof control.buttonDown !== "function" ||
        typeof control.buttonUp !== "function" ||
        typeof control.move !== "function"
      ) {
        return null;
      }
      // `control` is structurally a superset of NekoPointerControl. The
      // package's interface narrows to {buttonDown, buttonUp, move,
      // (touchBegin/Update/End?)}; we cast at this boundary so the package
      // does not need to know about NekoInstance's full shape.
      return control as unknown as NekoPointerControl;
    },
    getTextareaElement(): HTMLTextAreaElement | null {
      return opts?.getTextarea?.() ?? null;
    },
    sendKeysym(keysym: number): void {
      dispatchNekoKeysymForAdapter(keysym);
    },
    mapPointerToRemote(xLocal: number, yLocal: number): { x: number; y: number } {
      // Open question (step 2) resolved: `getNekoControlPos` takes
      // viewport-absolute clientX/clientY. The dashboard passes
      // event.clientX/clientY at the wire site, so this is 1:1.
      const mapped = mapNekoPointerToRemoteForAdapter(xLocal, yLocal);
      if (mapped) {
        return mapped;
      }
      // Fall back to identity. The adapter logs a warning when the
      // mapper is missing; here we return *something* so the controller
      // does not throw. The controller's no-mapping warning fires upstream.
      return { x: xLocal, y: yLocal };
    },
  };
}
