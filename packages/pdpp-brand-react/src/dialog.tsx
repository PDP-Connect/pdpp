// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * Dialog — Ink Carbon modal primitive.
 *
 * A thin Ink Carbon SKIN over @base-ui/react's Dialog. base-ui owns the hard
 * parts — focus-trap, Escape/overlay dismissal, scroll-lock, portal mounting,
 * and the full ARIA wiring. This module owns ONLY the Ink Carbon styling:
 * square corners, a hairline --border, --card background, a mono title eyebrow,
 * and the single resting-shadow exception the spec grants modal/menu surfaces
 * (a dialog floats above the page, so it earns one soft elevation shadow that
 * flat document surfaces never do).
 *
 * The component surface mirrors the operator-ui Dialog one-to-one
 * (Root/Trigger/Portal/Backdrop/Popup/Title/Description/Close) so a console
 * import swap is mechanical — only the styling changes. Props pass straight
 * through to the underlying base-ui parts.
 *
 * Prefixed `Ic` to avoid collision with operator-ui imports during migration.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { type ComponentProps, forwardRef } from "react";
import "./components.css";

/**
 * base-ui parts accept `className` as either a string or a state-driven function
 * `(state) => string | undefined`. We prepend the Ink Carbon token class while
 * preserving whichever form the caller passed: a function caller still gets its
 * state argument, and our base class rides in front of the resolved string.
 */
type StateClassName<State> = string | ((state: State) => string | undefined) | undefined;

function mergeClass<State>(base: string, caller: StateClassName<State>): StateClassName<State> {
  if (typeof caller === "function") {
    return (state: State) => [base, caller(state)].filter(Boolean).join(" ");
  }
  return [base, caller].filter(Boolean).join(" ");
}

// Root / Trigger / Portal / Close are pass-throughs — no styling to add.
const IcDialog = DialogPrimitive.Root;
const IcDialogTrigger = DialogPrimitive.Trigger;
const IcDialogPortal = DialogPrimitive.Portal;
const IcDialogClose = DialogPrimitive.Close;

const IcDialogBackdrop = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Backdrop>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Backdrop
      className={mergeClass("pdpp-dialog-backdrop", className)}
      data-slot="dialog-backdrop"
      ref={ref}
      {...props}
    />
  )
);
IcDialogBackdrop.displayName = "IcDialogBackdrop";

const IcDialogPopup = forwardRef<HTMLDivElement, ComponentProps<typeof DialogPrimitive.Popup>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Popup
      className={mergeClass("pdpp-dialog", className)}
      data-slot="dialog-popup"
      ref={ref}
      {...props}
    />
  )
);
IcDialogPopup.displayName = "IcDialogPopup";

const IcDialogTitle = forwardRef<HTMLHeadingElement, ComponentProps<typeof DialogPrimitive.Title>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Title
      className={mergeClass("pdpp-dialog__title", className)}
      data-slot="dialog-title"
      ref={ref}
      {...props}
    />
  )
);
IcDialogTitle.displayName = "IcDialogTitle";

const IcDialogDescription = forwardRef<HTMLParagraphElement, ComponentProps<typeof DialogPrimitive.Description>>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Description
      className={mergeClass("pdpp-dialog__desc", className)}
      data-slot="dialog-description"
      ref={ref}
      {...props}
    />
  )
);
IcDialogDescription.displayName = "IcDialogDescription";

export {
  IcDialog,
  IcDialogBackdrop,
  IcDialogClose,
  IcDialogDescription,
  IcDialogPopup,
  IcDialogPortal,
  IcDialogTitle,
  IcDialogTrigger,
};
