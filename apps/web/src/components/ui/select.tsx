import * as React from "react";

import { cn } from "@/lib/utils.ts";

// A styled native <select>. Intentionally native — the dashboard relies on
// browser-native form submission via `<form method="get">`, so an
// uncontrolled element is the right shape. Use `@base-ui/react/select`
// when we need a headless combobox with search or portal-positioned popup.

const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => (
    <div className="relative inline-flex w-full items-center">
      <select
        ref={ref}
        data-slot="select"
        className={cn(
          "pdpp-body inline-flex h-8 w-full min-w-0 appearance-none rounded-md border border-border bg-background py-1 pr-7 pl-2.5 text-foreground outline-none transition-colors hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-2.5 h-3 w-3 text-muted-foreground"
      >
        <path
          d="M3 4.5 L6 7.5 L9 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
);
Select.displayName = "Select";

export { Select };
