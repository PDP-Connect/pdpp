/**
 * Tag — taxonomy label, neutral, no color spent.
 *
 * Used for classification labels: connector types, record kinds,
 * feature flags. Always mono voice, always muted. No state color.
 */
import type { ReactNode } from "react";
import "./components.css";

interface TagProps {
  children: ReactNode;
  className?: string;
}

export function Tag({ children, className }: TagProps) {
  return <span className={["pdpp-tag", className].filter(Boolean).join(" ")}>{children}</span>;
}
