// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { keysymToCdpKey } from "@opendatalabs/remote-surface/backends/cdp";
import type { ClipboardPolicyDecision, StreamSessionBackend } from "@opendatalabs/remote-surface/client";
import { MobileTextInputController } from "@opendatalabs/remote-surface/ime";

/**
 * Explicit ready-backend state, reusing the package's own `StreamSessionBackend`
 * (`"neko" | "cdp" | "unknown"`). `"unknown"` covers pre-`backend_ready` and any
 * backend value the console does not recognize — both must fail closed rather
 * than default into the CDP mobile-control surface, since `backend_ready`'s
 * wire shape is deliberately extensible (`backend: "cdp" | "neko" | string`).
 */
export type ReadyBackend = StreamSessionBackend;

/** Narrow a raw `backend_ready` payload's `backend` field to a `ReadyBackend`. */
export function classifyReadyBackend(backend: string): ReadyBackend {
  return backend === "cdp" || backend === "neko" ? backend : "unknown";
}

/** The narrow host-facing portion of a mounted direct-CDP surface. */
export interface MountedCdpSurface {
  focusTextInput: () => void;
  getLifecycleState: () => string;
}

/**
 * Keeps the package's clipboard direction/capability decision authoritative,
 * while supplying the direct-CDP mobile keyboard affordance that package
 * version 1.5.1 deliberately withholds from its generic policy table.
 */
export function decideCdpMobileControls({
  backend,
  clipboardPolicy,
  pointerCoarse,
}: {
  backend: ReadyBackend;
  clipboardPolicy: ClipboardPolicyDecision;
  pointerCoarse: boolean;
}) {
  const visible = backend === "cdp" && pointerCoarse && clipboardPolicy.surface === "mobile-sheet";
  return {
    showCopy: visible && clipboardPolicy.showMobileCopyButton,
    showKeyboard: visible,
    showPaste: visible && clipboardPolicy.showMobilePasteButton,
  };
}

/**
 * Call directly from the button's trusted event handler. Browsers only honour
 * an input focus that occurs before the handler returns, so this must stay
 * synchronous and must not be moved into an effect or promise continuation.
 */
export function focusMountedCdpTextInputInTrustedEvent(surface: MountedCdpSurface | null): boolean {
  if (surface?.getLifecycleState() !== "mounted") {
    return false;
  }
  try {
    surface.focusTextInput();
    return true;
  } catch {
    // A teardown can win the race after the lifecycle check. Do not focus a
    // detached input or throw from an owner gesture; the next mounted surface
    // can be explicitly invoked by the owner.
    return false;
  }
}

/** The narrow CdpClientSurface surface the IME bridge drives. */
export interface CdpTextInputTarget {
  sendKey: (intent: {
    type: "keydown" | "keyup";
    code?: string;
    key?: string;
    modifiers?: readonly ("Alt" | "Control" | "Meta" | "Shift")[];
  }) => Promise<void>;
  sendText: (text: string) => Promise<void>;
}

/**
 * Mirrors the package's own `createSoftKeyboardBridge`
 * (`remote-surface-session.js`) mobile-IME pattern for the direct-CDP path:
 * a hidden textarea marked `data-remote-surface-ime-bridge` drives
 * `MobileTextInputController`, whose committed text and chorded special keys
 * are forwarded through the adapter's existing `sendText`/`sendKey`
 * primitives — no new wire command. `getSoftKeyboardElement()` on the adapter
 * only calls `.focus()`; typing itself needs this controller wired to a real
 * textarea because a plain controlled `<input>` with a no-op `onChange` never
 * fires `beforeinput`/`input`/composition events the package's input router
 * can read (an `INPUT` tag off the bridge is classified `host-editable` and
 * ignored). The textarea is host-owned (React renders/refs it, matching
 * `getSoftKeyboardElement()`'s existing focus target) rather than created
 * here, so focus() and the IME listeners share one element.
 */
export function attachCdpMobileTextInputBridge(
  textarea: HTMLTextAreaElement | null,
  surface: CdpTextInputTarget,
  onDispatchError?: (error: unknown) => void
): () => void {
  if (!textarea) {
    return () => {
      /* The host has not committed its focus target; remain fail closed. */
    };
  }
  textarea.dataset.remoteSurfaceImeBridge = "true";

  const reportDispatchError = (error: unknown) => {
    onDispatchError?.(error);
  };

  const controller = new MobileTextInputController({
    onSpecialKey: (keysym, modifiers) => {
      const key = keysymToCdpKey(keysym);
      const intent = {
        code: key.code,
        key: key.key,
        ...(modifiers ? { modifiers } : {}),
      };
      surface.sendKey({ type: "keydown", ...intent }).catch(reportDispatchError);
      surface.sendKey({ type: "keyup", ...intent }).catch(reportDispatchError);
    },
    onTextCommit: (text) => {
      surface.sendText(text).catch(reportDispatchError);
    },
    textarea,
  });

  return () => {
    controller.dispose();
    delete textarea.dataset.remoteSurfaceImeBridge;
  };
}

/**
 * `CdpClientSurface.copyRemoteSelection()` treats a resolved clipboard sink
 * write as a successful copy. Write through here rather than buffering first;
 * a buffer is only the manual fallback after the device write is unavailable
 * or rejected.
 */
export async function writeCdpClipboardToDevice({
  onWriteFailure,
  policy,
  text,
  writeText,
}: {
  onWriteFailure: (text: string) => void;
  policy: ClipboardPolicyDecision;
  text: string;
  writeText: ((text: string) => Promise<void> | void) | null;
}): Promise<void> {
  if (!(policy.canWriteLocalClipboard && writeText)) {
    onWriteFailure(text);
    throw new Error("Device clipboard write is unavailable");
  }
  try {
    await writeText(text);
  } catch (error) {
    onWriteFailure(text);
    throw error;
  }
}
