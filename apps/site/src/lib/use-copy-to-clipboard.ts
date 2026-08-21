// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useCopyToClipboard — the copy-button state machine shared by every
 * copy-to-clipboard control on the concept surface (the self-host command
 * panel, the terminal block).
 *
 * Both call sites used to keep their own copy of this: identical `copied` /
 * `failed` state, the same try/catch around `navigator.clipboard.writeText`,
 * and the same 2s auto-reset. One had it, one didn't, and a third call site
 * would have had to choose which copy to clone. Now there is one state
 * machine; a caller supplies the text to copy and reads `status` (idle /
 * copied / failed) to render its own label and aria-live announcement.
 *
 * navigator.clipboard is undefined on insecure origins and rejects when the
 * permission is denied — `status` becomes "failed" rather than silently
 * doing nothing, so a caller can say so instead of showing a false "Copied".
 */

import { useCallback, useEffect, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

const RESET_DELAY_MS = 2000;

export function useCopyToClipboard() {
  const [status, setStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const timer = setTimeout(() => setStatus("idle"), RESET_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const copy = useCallback(async (text: string) => {
    setStatus("idle");
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }, []);

  return { copy, status };
}

/** Pure label/status-text derivation, split out so it's testable without mounting the hook. */
export function copyStatusText(status: CopyStatus): { announcement: string; label: string } {
  if (status === "copied") {
    return { announcement: "Command copied to clipboard.", label: "Copied" };
  }
  if (status === "failed") {
    return { announcement: "Copy failed.", label: "Copy failed" };
  }
  return { announcement: "", label: "Copy" };
}
