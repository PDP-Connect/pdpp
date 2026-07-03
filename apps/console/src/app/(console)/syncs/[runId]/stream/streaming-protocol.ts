/**
 * Constants shared between the run-interaction streaming server action and
 * the streaming viewer client component. This module deliberately has no
 * imports — it must be safe to load from a `"use client"` component without
 * dragging server-only code into the client bundle.
 *
 * Server-action error boundaries strip prototype identity, so the action
 * re-throws unavailable errors with this stable message prefix and the
 * client matches on it without relying on `instanceof`.
 */
export const STREAMING_UNAVAILABLE_TAG = "STREAMING_COMPANION_UNAVAILABLE: ";
