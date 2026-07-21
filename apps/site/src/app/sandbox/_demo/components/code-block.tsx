// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

/**
 * Display a JSON or shell snippet with monospace styling. Server-rendered;
 * the live dashboard uses an interactive copy button — for the sandbox we
 * just rely on selectable text to keep the surface entirely server.
 */
export function CodeBlock({ language, children }: { language?: "json" | "shell" | "http"; children: ReactNode }) {
  return (
    <pre
      className="pdpp-caption mt-1 overflow-x-auto rounded-md border border-border/70 bg-muted/40 px-3 py-2 font-mono text-foreground"
      data-language={language}
    >
      {children}
    </pre>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="pdpp-caption rounded bg-muted px-1 py-[1px] font-mono text-foreground">{children}</code>;
}
