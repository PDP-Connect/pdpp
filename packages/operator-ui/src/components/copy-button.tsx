"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface CopyButtonProps {
  ariaLabel?: string;
  className?: string;
  size?: "sm" | "md";
  value: string;
}

const RESET_MS = 1400;

/**
 * Copy-to-clipboard affordance for protocol-inspectable values — URLs, IDs,
 * token strings, JSON fragments. One primitive, one gesture. Pair with any
 * monospace value elsewhere in the dashboard.
 */
export function CopyButton({ value, ariaLabel, size = "sm", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), RESET_MS);
    } catch {
      // Clipboard unavailable (insecure origin, permission denied). Fail silent —
      // the visible URL is already selectable.
    }
  }, [value]);

  const dim = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const icon = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  const label = ariaLabel ?? `Copy ${value}`;

  return (
    <button
      aria-label={label}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded",
        dim,
        "text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className ?? "",
      ].join(" ")}
      data-copied={copied ? "true" : undefined}
      onClick={onClick}
      title={copied ? "Copied" : label}
      type="button"
    >
      {copied ? <Check aria-hidden className={`${icon} text-success`} /> : <Copy aria-hidden className={icon} />}
    </button>
  );
}
