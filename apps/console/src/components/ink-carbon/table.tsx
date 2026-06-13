/**
 * Table — the aligned list primitive.
 *
 * Every list shares ONE column template via the `cols` prop on the Table
 * wrapper (maps to CSS --cols). This ensures every cell in a column sits
 * on the same axis across every row. Headers are mandatory.
 *
 * Numeric columns: pass `numeric` on TableHeader/TableCell to apply
 * right-align + tabular-nums (.u-r utility class).
 *
 * Usage:
 *   <Table cols="1fr 1fr 120px">
 *     <TableHeaderRow>
 *       <TableHeader>Client</TableHeader>
 *       <TableHeader>Scope</TableHeader>
 *       <TableHeader numeric>Expires</TableHeader>
 *     </TableHeaderRow>
 *     <TableRow>
 *       <TableCell>Acme</TableCell>
 *       <TableCell>read:statements</TableCell>
 *       <TableCell numeric>2026-09-01</TableCell>
 *     </TableRow>
 *   </Table>
 */
import type { CSSProperties, ReactNode } from "react";
import "./components.css";

// ─── Table ────────────────────────────────────────────────────────

interface TableProps {
  children: ReactNode;
  className?: string;
  /** CSS grid-template-columns value. Applied as --cols on the wrapper. */
  cols: string;
}

export function Table({ cols, className, children }: TableProps) {
  return (
    <div className={["pdpp-table", className].filter(Boolean).join(" ")} style={{ "--cols": cols } as CSSProperties}>
      {children}
    </div>
  );
}

// ─── TableHeaderRow ───────────────────────────────────────────────

interface TableHeaderRowProps {
  children: ReactNode;
  className?: string;
}

export function TableHeaderRow({ className, children }: TableHeaderRowProps) {
  return <div className={["pdpp-table__hrow", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ─── TableHeader ──────────────────────────────────────────────────

interface TableHeaderProps {
  children: ReactNode;
  className?: string;
  /** Right-align with tabular-nums for numeric columns. */
  numeric?: boolean;
}

export function TableHeader({ numeric, className, children }: TableHeaderProps) {
  const cls = ["pdpp-table__h", numeric ? "u-r" : undefined, className].filter(Boolean).join(" ");
  return <span className={cls}>{children}</span>;
}

// ─── TableRow ─────────────────────────────────────────────────────

interface TableRowProps {
  children: ReactNode;
  className?: string;
  /** Render as a <button> row for clickable rows */
  onClick?: () => void;
}

export function TableRow({ className, children, onClick }: TableRowProps) {
  const cls = ["pdpp-table__row", className].filter(Boolean).join(" ");
  if (onClick) {
    // Reset only the button chrome (background/border/font/color/text-align) so
    // the `.pdpp-table__row` grid template, gap, and alignment survive — using
    // `all: unset` here would wipe the column grid the row depends on.
    return (
      <button
        className={cls}
        onClick={onClick}
        style={{
          appearance: "none",
          background: "none",
          border: 0,
          color: "inherit",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
          width: "100%",
        }}
        type="button"
      >
        {children}
      </button>
    );
  }
  return <div className={cls}>{children}</div>;
}

// ─── TableCell ────────────────────────────────────────────────────

interface TableCellProps {
  children?: ReactNode;
  className?: string;
  /** Right-align with tabular-nums for numeric data. */
  numeric?: boolean;
}

export function TableCell({ numeric, className, children }: TableCellProps) {
  const cls = [numeric ? "u-r" : undefined, className].filter(Boolean).join(" ");
  return cls ? <span className={cls}>{children}</span> : <span>{children}</span>;
}
