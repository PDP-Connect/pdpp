"use client";

import React from "react";

// ─── Spec Citation ───────────────────────────────────────────────────────────

// A reusable inline spec reference. Uses --edu-fg for the protocol education layer.
// Renders as a mono link with the § prefix.

export type SpecCitationProps = {
  section: string; // e.g. "4.2" or "6.1"
  label: string; // e.g. "Selection Request"
  href?: string; // optional link to spec page
};

export function SpecCitation({ section, label, href }: SpecCitationProps) {
  const content = (
    <span className="font-mono text-xs" style={{ color: "var(--edu-fg)" }}>
      {"§"}
      {section} {label}
    </span>
  );

  if (href) {
    return (
      <a href={href} className="transition-opacity hover:opacity-70">
        {content}
      </a>
    );
  }
  return content;
}

// Spec citation group — multiple citations in a row with separators
export function SpecCitationGroup({ citations }: { citations: SpecCitationProps[] }) {
  return (
    <span
      className="inline-flex flex-wrap items-baseline gap-2 rounded-md px-2.5 py-1.5"
      style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
    >
      {citations.map((c, i) => (
        <React.Fragment key={c.section}>
          {i > 0 && (
            <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              &middot;
            </span>
          )}
          <SpecCitation {...c} />
        </React.Fragment>
      ))}
    </span>
  );
}
