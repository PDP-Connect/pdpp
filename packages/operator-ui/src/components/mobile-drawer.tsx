"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from "../ui/dialog.tsx";

interface MobileDrawerContextValue {
  close: () => void;
  isOpen: boolean;
  open: () => void;
  setOpen: (open: boolean) => void;
}

const MobileDrawerContext = createContext<MobileDrawerContextValue | null>(null);

function useMobileDrawer(): MobileDrawerContextValue {
  const context = useContext(MobileDrawerContext);
  if (!context) {
    throw new Error("Mobile drawer components must be rendered inside <MobileDrawerProvider>");
  }
  return context;
}

export function MobileDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);

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

  const value = useMemo<MobileDrawerContextValue>(
    () => ({
      close: () => setOpen(false),
      isOpen,
      open: () => setOpen(true),
      setOpen,
    }),
    [isOpen]
  );

  return <MobileDrawerContext.Provider value={value}>{children}</MobileDrawerContext.Provider>;
}

export function MobileDrawerTrigger() {
  const drawer = useMobileDrawer();
  return (
    <Button
      aria-label="Open navigation"
      className="md:hidden"
      onClick={drawer.open}
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
  const drawer = useMobileDrawer();
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    function closeOnLinkClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("a")) {
        drawer.close();
      }
    }
    content.addEventListener("click", closeOnLinkClick);
    return () => content.removeEventListener("click", closeOnLinkClick);
  }, [drawer]);

  return (
    <Dialog modal onOpenChange={drawer.setOpen} open={drawer.isOpen}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          aria-label="Navigation"
          className="fixed inset-y-0 top-0 left-0 m-0 flex h-full w-72 max-w-[85%] -translate-x-0 -translate-y-0 flex-col gap-0 rounded-none rounded-r-lg border-border/80 border-r border-l-0 bg-background p-0 shadow-2xl data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full data-[ending-style]:scale-100 data-[starting-style]:scale-100"
        >
          <div className="flex items-center justify-between border-border/70 border-b px-5 py-3">
            <span className="pdpp-eyebrow">Navigation</span>
            <Button aria-label="Close navigation" onClick={drawer.close} size="icon-xs" type="button" variant="ghost">
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
