/**
 * Pure formatting helpers for the operator-facing `next_action` CTA.
 *
 * The reference server projects a `next_action` field on every
 * connection-health snapshot. The dashboard renders it verbatim — it
 * never invents a CTA from raw health axes, never fabricates an
 * `action_target` link, and never spells out a secret value.
 *
 * Contract:
 *   - `next_action: null` → no CTA. (No attention required.)
 *   - `source === "structured"` → a durable structured-attention record
 *     drove the projection. Render the label confidently.
 *   - `source === "schedule_fallback"` → only the schedule's
 *     `human_attention_needed` flag was visible; the precise prompt is
 *     unknown. Render the label AND a caveat so owners are not misled
 *     about the system's certainty.
 *   - `action_target === null` → render the CTA as plain text (no
 *     link/button). Never fabricate a target URL.
 *
 * Kept pure + test-first to keep the JSX render thin.
 */

import type { RefNextAction } from "./ref-client.ts";

export type NextActionSource = RefNextAction["source"];
export type NextActionVariant = "structured" | "schedule_fallback";

export interface FormattedNextAction {
  /**
   * Non-secret action target string from the spine, when present.
   * `null` means render no link/button (the CTA is informational).
   */
  actionTarget: string | null;
  /**
   * Secondary line for `schedule_fallback` variants. The system only
   * knows attention is needed; we say so honestly. `null` for
   * structured CTAs.
   */
  caveat: string | null;
  /**
   * Short, owner-facing label. Drawn from the registered display copy
   * for `reason_code` when available, otherwise a humanized fallback
   * combined with `owner_action`. Never the raw code on its own.
   */
  label: string;
  variant: NextActionVariant;
}

/**
 * Humanize a snake_case reason code for display. Never returns the
 * code unchanged so an unregistered code reads as a sentence, not a
 * machine identifier. Empty/null inputs return null so callers can
 * fall back without first comparing strings.
 */
export function humanizeReasonCode(code: string | null | undefined): string | null {
  if (!code) {
    return null;
  }
  const cleaned = code.trim();
  if (cleaned.length === 0) {
    return null;
  }
  const known = REASON_LABELS[cleaned];
  if (known) {
    return known;
  }
  const spaced = cleaned.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (spaced.length === 0) {
    return null;
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const OWNER_ACTION_VERB: Record<NonNullable<RefNextAction["owner_action"]>, string> = {
  provide_value: "Provide input",
  act_elsewhere: "Continue on the provider",
  operate_attachment: "Open the linked tool",
};

const REASON_LABELS: Record<string, string> = {
  browser_runtime_not_configured: "Browser runtime not configured",
  manual_verification: "Manual verification required",
  needs_human_attention: "Attention needed",
  otp_required: "OTP required",
  push_approval_required: "Approve sign-in",
};

/**
 * Render `next_action` into the small set of strings the JSX layer
 * consumes. Returns null when there is nothing to show. Pure and
 * side-effect-free so it is trivial to unit-test against the contract.
 */
export function formatNextAction(action: RefNextAction | null | undefined): FormattedNextAction | null {
  if (!action) {
    return null;
  }
  if (action.source === "none") {
    return null;
  }

  const humanized = humanizeReasonCode(action.reason_code);
  const ownerVerb = action.owner_action ? OWNER_ACTION_VERB[action.owner_action] : null;

  let label: string;
  if (humanized && ownerVerb) {
    label = `${ownerVerb}: ${humanized}`;
  } else if (humanized) {
    label = humanized;
  } else if (ownerVerb) {
    label = ownerVerb;
  } else if (action.source === "schedule_fallback") {
    label = "Attention needed";
  } else {
    // Structured attention with neither owner_action nor reason_code is
    // unusual but possible. Be honest about it rather than inventing copy.
    label = "Attention needed";
  }

  const caveat =
    action.source === "schedule_fallback" ? "Details unavailable — open the connection to see what's needed." : null;

  return {
    label,
    caveat,
    actionTarget: action.action_target ?? null,
    variant: action.source === "schedule_fallback" ? "schedule_fallback" : "structured",
  };
}
