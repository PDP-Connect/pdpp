import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type = "text", ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          "pdpp-body border-border bg-background text-foreground placeholder:text-muted-foreground/70 hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-primary/20 aria-invalid:border-destructive aria-invalid:ring-destructive/20 inline-flex h-8 w-full min-w-0 rounded-md border px-2.5 py-1 outline-none transition-colors focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          className
        )}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
