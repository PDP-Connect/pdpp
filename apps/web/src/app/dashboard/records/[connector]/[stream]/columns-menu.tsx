"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Popover, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverTrigger } from "@/components/ui/popover.tsx";

export function ColumnsMenu({
  allColumns,
  defaultColumns,
  selectedColumns,
  mode,
}: {
  allColumns: string[];
  defaultColumns: string[];
  selectedColumns: string[];
  mode: "default" | "custom" | "all";
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const params = useSearchParams();

  const apply = useCallback(
    (columns: "reset" | "all" | string[]) => {
      const next = new URLSearchParams(params.toString());
      if (columns === "reset") {
        next.delete("columns");
      } else if (columns === "all") {
        next.set("columns", "*");
      } else if (columns.length === 0) {
        next.delete("columns");
      } else {
        next.set("columns", columns.join(","));
      }
      const qs = next.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [params, router]
  );

  const toggle = useCallback(
    (column: string) => {
      const base = mode === "default" ? defaultColumns : selectedColumns;
      const has = base.includes(column);
      const nextSet = has ? base.filter((c) => c !== column) : [...base, column];
      const ordered = allColumns.filter((c) => nextSet.includes(c));
      if (ordered.length === defaultColumns.length && ordered.every((c, i) => defaultColumns[i] === c)) {
        apply("reset");
      } else {
        apply(ordered);
      }
    },
    [allColumns, defaultColumns, selectedColumns, mode, apply]
  );

  const count = selectedColumns.length;
  let label = `Columns · ${count} default`;
  if (mode === "all") {
    label = `Columns · all ${count}`;
  } else if (mode === "custom") {
    label = `Columns · ${count}`;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="pdpp-label inline-flex h-8 items-center rounded-md border border-border/80 bg-background px-3 text-foreground transition-colors hover:bg-muted/60 data-[popup-open]:bg-muted/60">
        {label}
        <span aria-hidden className="ml-2 text-muted-foreground">
          ▾
        </span>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverPositioner align="end" sideOffset={4}>
          <PopoverPopup className="w-72 overflow-hidden">
            <div className="border-border/70 border-b px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="pdpp-eyebrow">Displayed columns</span>
                <div className="pdpp-caption flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => apply("reset")}
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Default
                  </button>
                  <span className="text-muted-foreground/40">·</span>
                  <button
                    type="button"
                    onClick={() => apply("all")}
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Show all
                  </button>
                </div>
              </div>
            </div>
            <ul className="max-h-80 overflow-y-auto overscroll-contain py-1">
              {allColumns.map((column) => {
                const checked = selectedColumns.includes(column);
                return (
                  <li key={column}>
                    <label className="pdpp-caption flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-muted/40">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-foreground"
                        checked={checked}
                        onChange={() => toggle(column)}
                      />
                      <span className="flex-1 font-mono">{column}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="pdpp-caption border-border/70 border-t px-3 py-2 text-muted-foreground">
              <Link
                href="?columns=*"
                scroll={false}
                className="underline-offset-2 hover:underline"
                onClick={() => setOpen(false)}
              >
                Share this view
              </Link>
              <span className="ml-2 text-muted-foreground/60">— URL state</span>
            </div>
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  );
}
