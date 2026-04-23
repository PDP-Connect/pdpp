import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"

// shadcn-style wrapper over @base-ui/react/dialog. Provides focus-trap,
// Escape/overlay dismiss, and portal mounting for free. Use for modal surfaces
// that take over the viewport.

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogBackdrop = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    data-slot="dialog-backdrop"
    className={cn(
      "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150",
      className
    )}
    {...props}
  />
))
DialogBackdrop.displayName = "DialogBackdrop"

const DialogPopup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Popup>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Popup
    ref={ref}
    data-slot="dialog-popup"
    className={cn(
      "border-border/80 bg-background fixed top-1/2 left-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border p-5 shadow-2xl outline-none",
      "data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-[opacity,transform] duration-150",
      className
    )}
    {...props}
  />
))
DialogPopup.displayName = "DialogPopup"

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentProps<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn("pdpp-title text-foreground", className)}
    {...props}
  />
))
DialogTitle.displayName = "DialogTitle"

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentProps<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn("pdpp-body text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = "DialogDescription"

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogClose,
}
