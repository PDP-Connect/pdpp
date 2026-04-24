"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "@/components/ui/dialog.tsx";

// Shared open/close handle so the trigger button (in the topbar) and the drawer
// itself can live in different subtrees of the server-rendered shell without
// needing a full React Context for a single boolean flag.
let setOpenRef: (open: boolean) => void = () => {};

export function MobileDrawerTrigger() {
  return (
    <Button
      type="button"
      onClick={() => setOpenRef(true)}
      aria-label="Open navigation"
      variant="outline"
      size="icon-sm"
      className="md:hidden"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      >
        <path d="M2 4h12M2 8h12M2 12h12" />
      </svg>
    </Button>
  );
}

export function MobileDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpenRef = setOpen;
    return () => {
      setOpenRef = () => {};
    };
  }, []);

  // Auto-close once we cross back above the `md` breakpoint.
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    if (mql.matches) {
      setOpen(false);
    }
    function onChange(event: MediaQueryListEvent) {
      if (event.matches) {
        setOpen(false);
      }
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen} modal>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          className="fixed inset-y-0 top-0 left-0 m-0 flex h-full w-72 max-w-[85%] -translate-x-0 -translate-y-0 flex-col gap-0 rounded-none rounded-r-lg border-border/80 border-r border-l-0 bg-background p-0 shadow-2xl data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full data-[ending-style]:scale-100 data-[starting-style]:scale-100"
          aria-label="Navigation"
        >
          <div className="flex items-center justify-between border-border/70 border-b px-5 py-3">
            <span className="pdpp-eyebrow">Navigation</span>
            <Button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
              variant="ghost"
              size="icon-xs"
            >
              ×
            </Button>
          </div>
          <div
            className="flex-1 overflow-y-auto overscroll-contain px-5 py-5"
            onClick={(event) => {
              const target = event.target as HTMLElement | null;
              if (target?.closest("a")) {
                setOpen(false);
              }
            }}
          >
            {children}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
