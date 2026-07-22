// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ComponentProps, forwardRef } from "react";

import { cn } from "./utils.ts";

// A styled native <select>. Intentionally native — the dashboard relies on
// browser-native form submission via `<form method="get">`, so an
// uncontrolled element is the right shape. Use `@base-ui/react/select`
// when we need a headless combobox with search or portal-positioned popup.

const Select = forwardRef<HTMLSelectElement, ComponentProps<"select">>(({ className, children, ...props }, ref) => (
  <div className="relative inline-flex w-full items-center">
    <select
      className={cn(
        "pdpp-body inline-flex h-8 w-full min-w-0 appearance-none rounded-md border border-border bg-background py-1 pr-7 pl-2.5 text-foreground outline-none transition-colors hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      data-slot="select"
      ref={ref}
      {...props}
    >
      {children}
    </select>
    <svg
      aria-hidden
      className="pointer-events-none absolute right-2.5 h-3 w-3 text-muted-foreground"
      viewBox="0 0 12 12"
    >
      <title>Select arrow</title>
      <path
        d="M3 4.5 L6 7.5 L9 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  </div>
));
Select.displayName = "Select";

export { Select };
