// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Input + Field — Ink Carbon form primitives.
 *
 * IcInput: a styled text input. Mono voice (protocol data entry).
 * IcField: wraps an input with a label and optional hint.
 *
 * Prefixed `Ic` to avoid collision with operator-ui imports during migration.
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import "./components.css";

// ─── IcInput ──────────────────────────────────────────────────────

export interface IcInputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

const IcInput = forwardRef<HTMLInputElement, IcInputProps>(({ className, ...props }, ref) => (
  <input className={["pdpp-input", className].filter(Boolean).join(" ")} ref={ref} {...props} />
));
IcInput.displayName = "IcInput";

// ─── IcField ──────────────────────────────────────────────────────

interface IcFieldProps {
  children: ReactNode;
  className?: string;
  hint?: string;
  htmlFor?: string;
  label: string;
}

function IcField({ label, hint, htmlFor, className, children }: IcFieldProps) {
  return (
    <div className={["pdpp-field", className].filter(Boolean).join(" ")}>
      <label className="pdpp-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className="pdpp-field__hint">{hint}</span>}
    </div>
  );
}

export { IcField, IcInput };
