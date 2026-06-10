import { type ComponentProps, forwardRef } from "react";

import { cn } from "../../ui/utils.ts";

const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "pdpp-body block w-full min-w-0 resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-foreground/30 focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
      className
    )}
    data-slot="textarea"
    ref={ref}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
