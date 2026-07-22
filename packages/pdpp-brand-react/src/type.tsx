// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Type system — Ink Carbon typographic components.
 *
 * VOICE RULE (load-bearing):
 *   Mono  = protocol  — IDs, scopes, timestamps, terms, machine output
 *   Grotesk = human   — labels, descriptions, UI copy, names
 *
 * Components: Display, Heading, Title, Body, Label, Caption, Typed,
 *             TypedSm, Eyebrow.
 *
 * Alternatively use the .pdpp-* CSS classes directly for one-offs.
 */
import type { ElementType, HTMLAttributes, ReactNode } from "react";
import "./components.css";

// ─── Shared helper ────────────────────────────────────────────────

type AsProp<T extends ElementType> = {
  as?: T;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "as">;

// ─── Display ──────────────────────────────────────────────────────

/** 60px grotesk 700 — top-of-page hero heading. */
export function Display({ as: Tag = "h1", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-display-lg", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

/** 40px grotesk 700 — section display heading. */
export function DisplayMd({ as: Tag = "h2", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-display", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

// ─── Heading ──────────────────────────────────────────────────────

/** 20px grotesk 700 — page section headings. */
export function Heading({ as: Tag = "h2", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-heading", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

// ─── Title ────────────────────────────────────────────────────────

/** 14px grotesk 600 — card/row titles. */
export function Title({ as: Tag = "h3", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-title", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

// ─── Body ─────────────────────────────────────────────────────────

/** 18px grotesk 400 — lead/intro body text. */
export function BodyLg({ as: Tag = "p", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-body-lg", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

/** 14px grotesk 400 — standard body text. */
export function Body({ as: Tag = "p", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-body", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

// ─── Label / Caption ──────────────────────────────────────────────

/** 12px grotesk 500 — UI labels. */
export function Label({ as: Tag = "span", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-label", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

/** 12px grotesk 400 — helper / caption text. */
export function Caption({ as: Tag = "span", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-caption", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

// ─── Typed (mono = protocol voice) ────────────────────────────────

/** 13px mono 500 — IDs, scopes, timestamps, protocol data. */
export function Typed({ as: Tag = "span", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-typed", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

/** 11px mono 400 — small protocol metadata. */
export function TypedSm({ as: Tag = "span", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-typed-sm", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

// ─── Eyebrow ──────────────────────────────────────────────────────

/** 0.67rem mono 500 uppercase tracked — section eyebrow labels. */
export function Eyebrow({ as: Tag = "span", className, children, ...rest }: AsProp<ElementType>) {
  return (
    <Tag className={["pdpp-eyebrow", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}
