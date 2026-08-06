// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ClipboardPolicyDecision, StreamSessionBackend } from "@opendatalabs/remote-surface/client";

/**
 * Explicit ready-backend state. Unknown values fail closed until the server
 * announces a backend_ready event; direct-CDP controls are never inferred
 * from the absence of an n.eko session.
 */
export type ReadyBackend = StreamSessionBackend;

export function classifyReadyBackend(backend: string): ReadyBackend {
  return backend === "cdp" || backend === "neko" ? backend : "unknown";
}

/**
 * The assembled Remote Surface canvas session owns direct-CDP input, IME, and
 * viewport mechanics. PDPP keeps this small policy seam for the existing
 * explicit mobile controls only.
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
