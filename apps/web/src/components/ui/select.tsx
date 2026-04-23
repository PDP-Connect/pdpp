import * as React from "react"

import { cn } from "@/lib/utils"

// A styled native <select>. Intentionally native — the dashboard relies on
// browser-native form submission via `<form method="get">`, so an
// uncontrolled element is the right shape. Use `@base-ui/react/select`
// when we need a headless combobox with search or portal-positioned popup.

const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, children, ...props }, ref) => {
  return (
    <div className="relative inline-flex w-full items-center">
      <select
        ref={ref}
        data-slot="select"
        className={cn(
          "pdpp-body border-border bg-background text-foreground hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-primary/20 inline-flex h-8 w-full min-w-0 appearance-none rounded-md border pr-7 pl-2.5 py-1 outline-none transition-colors focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="text-muted-foreground pointer-events-none absolute right-2.5 h-3 w-3"
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
})
Select.displayName = "Select"

export { Select }
