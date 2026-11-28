// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CopyMono — a click-to-copy protocol identifier.
 *
 * Renders a mono-voice id (grant id, record id, connection id, query) as a
 * button. Clicking copies the text to the clipboard and briefly shows "copied"
 * before reverting. The id IS the affordance — no separate icon (the system has
 * no icon set; the typographic glyph and the hover tint carry it).
 *
 * Client component: it owns transient copied-state and touches the clipboard.
 */
"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import "./components.css";

interface CopyMonoProps {
  className?: string;
  /** Optional override for what gets copied. Defaults to `text`. */
  copyValue?: string;
  /** Confirmation feedback duration in ms. */
  feedbackMs?: number;
  /** The id/text to display and copy. */
  text: string;
}

const DEFAULT_FEEDBACK_MS = 1200;

export function CopyMono({ text, copyValue, className, feedbackMs = DEFAULT_FEEDBACK_MS }: CopyMonoProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const value = copyValue ?? text;

  useLayoutEffect(() => {
    setCopied(false);
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [text, value]);

  const onCopy = useCallback(async () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    const started = generation.current;
    try {
      await clipboard.writeText(value);
    } catch {
      return; // The identifier stays visible; no success feedback on refusal.
    }
    if (started !== generation.current) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), feedbackMs);
  }, [value, feedbackMs]);

  return (
    <button className={["rr-copyid", className].filter(Boolean).join(" ")} onClick={onCopy} title="Copy" type="button">
      {copied ? "copied" : text}
    </button>
  );
}
