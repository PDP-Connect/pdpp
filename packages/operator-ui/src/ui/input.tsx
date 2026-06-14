import { type ComponentProps, forwardRef } from "react";

import { cn } from "./utils.ts";

const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(({ className, type = "text", ...props }, ref) => (
  <input
    className={cn(
      "pdpp-body inline-flex h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-1 text-foreground outline-none transition-colors file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground/70 hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
      className
    )}
    data-slot="input"
    ref={ref}
    type={type}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
