import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { type ComponentProps, forwardRef } from "react";

import { cn } from "@/lib/utils.ts";

// shadcn-style wrapper over @base-ui/react/dialog. Provides focus-trap,
// Escape/overlay dismiss, and portal mounting for free. Use for modal surfaces
// that take over the viewport.

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogBackdrop = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Backdrop>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
        className
      )}
      data-slot="dialog-backdrop"
      ref={ref}
      {...props}
    />
  )
);
DialogBackdrop.displayName = "DialogBackdrop";

const DialogPopup = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Popup>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Popup
      className={cn(
        "fixed top-1/2 left-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-border/80 bg-background p-5 shadow-2xl outline-none",
        "transition-[opacity,transform] duration-150 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
        className
      )}
      data-slot="dialog-popup"
      ref={ref}
      {...props}
    />
  )
);
DialogPopup.displayName = "DialogPopup";

const DialogTitle = forwardRef<HTMLHeadingElement, ComponentProps<typeof DialogPrimitive.Title>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Title
      className={cn("pdpp-title text-foreground", className)}
      data-slot="dialog-title"
      ref={ref}
      {...props}
    />
  )
);
DialogTitle.displayName = "DialogTitle";

const DialogDescription = forwardRef<HTMLParagraphElement, ComponentProps<typeof DialogPrimitive.Description>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Description
      className={cn("pdpp-body text-muted-foreground", className)}
      data-slot="dialog-description"
      ref={ref}
      {...props}
    />
  )
);
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
