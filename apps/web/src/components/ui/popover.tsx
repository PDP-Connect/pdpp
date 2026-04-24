import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import * as React from "react";

import { cn } from "@/lib/utils.ts";

// shadcn-style wrapper over @base-ui/react/popover. Provides positioner,
// portal mounting, Escape/outside-click dismiss, and focus management.
// Use for non-modal surfaces attached to a specific anchor.

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverPortal = PopoverPrimitive.Portal;
const PopoverClose = PopoverPrimitive.Close;

const PopoverPositioner = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof PopoverPrimitive.Positioner>>(
  (props, ref) => <PopoverPrimitive.Positioner ref={ref} {...props} />
);
PopoverPositioner.displayName = "PopoverPositioner";

const PopoverPopup = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof PopoverPrimitive.Popup>>(
  ({ className, ...props }, ref) => (
    <PopoverPrimitive.Popup
      ref={ref}
      data-slot="popover-popup"
      className={cn(
        "z-40 rounded-md border border-border/80 bg-background shadow-lg outline-none",
        "transition-[opacity,transform] duration-100 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
        className
      )}
      {...props}
    />
  )
);
PopoverPopup.displayName = "PopoverPopup";

export { Popover, PopoverClose, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverTrigger };
