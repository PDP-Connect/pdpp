// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sheet — the basic paper artifact in Ink Carbon.
 *
 * A Sheet is a bounded document surface: square corners, strong border,
 * card background. Use Head/Title/Serial/Body/Foot subcomponents to
 * compose it. The serial slot is for protocol IDs (mono voice).
 *
 * Wrap in <Carbon> when the server retains this object on the owner's
 * behalf (staged consent, held grant, in-flight export). Never use
 * Carbon for decoration.
 */
import type { ReactNode } from "react";
import "./components.css";

// ─── Sheet ────────────────────────────────────────────────────────

interface SheetProps {
  children: ReactNode;
  className?: string;
}

export function Sheet({ className, children }: SheetProps) {
  return <div className={["pdpp-sheet", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── Sheet.Head ───────────────────────────────────────────────────

interface SheetHeadProps {
  children: ReactNode;
  className?: string;
}

export function SheetHead({ className, children }: SheetHeadProps) {
  return <div className={["pdpp-sheet__head", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── Sheet.Title ──────────────────────────────────────────────────

interface SheetTitleProps {
  /** Render as a different heading level. Defaults to h3. */
  as?: "h1" | "h2" | "h3" | "h4";
  children: ReactNode;
  className?: string;
}

export function SheetTitle({ as: Tag = "h3", className, children }: SheetTitleProps) {
  return <Tag className={["pdpp-sheet__title", className].filter(Boolean).join(" ")}>{children}</Tag>;
}

// ─── Sheet.Serial ─────────────────────────────────────────────────

interface SheetSerialProps {
  /** A protocol ID, grant ID, version string, or similar typed value. */
  children: ReactNode;
  className?: string;
}

export function SheetSerial({ children, className }: SheetSerialProps) {
  return <span className={["pdpp-sheet__serial", className].filter(Boolean).join(" ")}>{children}</span>;
}

// ─── Sheet.Body ───────────────────────────────────────────────────

interface SheetBodyProps {
  children: ReactNode;
  className?: string;
}

export function SheetBody({ className, children }: SheetBodyProps) {
  return <div className={["pdpp-sheet__body", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── Sheet.Foot ───────────────────────────────────────────────────

interface SheetFootProps {
  children: ReactNode;
  className?: string;
}

export function SheetFoot({ className, children }: SheetFootProps) {
  return <div className={["pdpp-sheet__foot", className].filter(Boolean).join(" ")}>{children}</div>;
}
