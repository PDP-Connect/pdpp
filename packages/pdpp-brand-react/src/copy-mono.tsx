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

import { useCallback, useRef, useState } from "react";
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCopy = useCallback(() => {
    const value = copyValue ?? text;
    // navigator.clipboard is unavailable in insecure contexts / older runtimes;
    // fail quietly rather than throwing — the id still reads on screen.
    const write = navigator.clipboard?.writeText(value);
    if (write) {
      write.catch(() => {
        /* clipboard denied — leave the value visible */
      });
    }
    setCopied(true);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(false), feedbackMs);
  }, [copyValue, text, feedbackMs]);

  return (
    <button className={["rr-copyid", className].filter(Boolean).join(" ")} onClick={onCopy} title="Copy" type="button">
      {copied ? "copied" : text}
    </button>
  );
}
