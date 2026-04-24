"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "@/components/ui/dialog.tsx";

// Shared open/close handle so the trigger button (in the topbar) and the drawer
// itself can live in different subtrees of the server-rendered shell without
// needing a full React Context for a single boolean flag.
function noopSetOpen(_open: boolean): void {
  // Placeholder until <MobileDrawer /> mounts and installs the real setter.
}
let setOpenRef: (open: boolean) => void = noopSetOpen;

export function MobileDrawerTrigger() {
  return (
    <Button
      aria-label="Open navigation"
      className="md:hidden"
      onClick={() => setOpenRef(true)}
      size="icon-sm"
      type="button"
      variant="outline"
    >
      <svg
        aria-hidden
        fill="none"
        height="14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
        viewBox="0 0 16 16"
        width="14"
      >
        <title>Menu</title>
        <path d="M2 4h12M2 8h12M2 12h12" />
      </svg>
    </Button>
  );
}

export function MobileDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpenRef = setOpen;
    return () => {
      setOpenRef = noopSetOpen;
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

  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    function closeOnLinkClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("a")) {
        setOpen(false);
      }
    }
    content.addEventListener("click", closeOnLinkClick);
    return () => content.removeEventListener("click", closeOnLinkClick);
  }, []);

  return (
    <Dialog modal onOpenChange={setOpen} open={open}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          aria-label="Navigation"
          className="fixed inset-y-0 top-0 left-0 m-0 flex h-full w-72 max-w-[85%] -translate-x-0 -translate-y-0 flex-col gap-0 rounded-none rounded-r-lg border-border/80 border-r border-l-0 bg-background p-0 shadow-2xl data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full data-[ending-style]:scale-100 data-[starting-style]:scale-100"
        >
          <div className="flex items-center justify-between border-border/70 border-b px-5 py-3">
            <span className="pdpp-eyebrow">Navigation</span>
            <Button
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              ×
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5" ref={contentRef}>
            {children}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
