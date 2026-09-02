// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The single place every deployment-specific value on the public site is
// declared. Nothing below is hard-coded at a call site.
//
// WHY A PLACEHOLDER AND NOT A DEFAULT: every value that is not yet settled
// resolves to a bracketed placeholder that RENDERS. A reader sees
// "[controller name not set]" on the page, which is the point — a wrong-but
// plausible default (a guessed contact address, a guessed controller) reads as
// fact and ships silently. The placeholder cannot be mistaken for a real
// value, and `unsetConfigValues()` below lists everything still outstanding so
// the PR checklist and a pre-launch check can both read it from one place.
//
// Server-only values (the deploy key, the KV credentials, the mail provider's
// API key) are NOT here and never reach the client bundle. They are read from
// the environment inside the API route. See app/api/sign/.

const PLACEHOLDER_PATTERN = /^\[.*\]$/;

/** Reads a public env var, falling back to a visible placeholder. */
function configured(value: string | undefined, placeholder: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : `[${placeholder}]`;
}

/** True when a value is still an unfilled placeholder. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

// Feature flags. All three default OFF: a flag that defaults on ships the
// feature the moment the code lands, which is the opposite of what a flag is
// for. `reviewOpen` gates the banner and the nav dropdown entry; `signingLive`
// gates the whole Supporter form and the /api/sign route; `operatorApplications`
// gates the Operator apply button on /participate.
function flag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export const siteFlags = {
  operatorApplications: flag(process.env.NEXT_PUBLIC_PDPP_OPERATOR_APPLICATIONS),
  reviewOpen: flag(process.env.NEXT_PUBLIC_PDPP_REVIEW_OPEN),
  signingLive: flag(process.env.NEXT_PUBLIC_PDPP_SIGNING_LIVE),
} as const;

export const siteConfig = {
  /** Where the Supporter form posts. Same-origin by default. */
  formEndpoint: configured(process.env.NEXT_PUBLIC_PDPP_FORM_ENDPOINT, "form endpoint not set"),

  /** Named on /privacy and under the form. The interim data controller. */
  controllerName: configured(process.env.NEXT_PUBLIC_PDPP_CONTROLLER_NAME, "controller name not set"),

  /** The footer's General contact. Deliberately NOT the reports mailbox. */
  generalContact: configured(process.env.NEXT_PUBLIC_PDPP_GENERAL_CONTACT, "general contact address not set"),

  /** Named on /privacy as the address for a data question. */
  privacyContact: configured(process.env.NEXT_PUBLIC_PDPP_PRIVACY_CONTACT, "privacy contact address not set"),

  /** The transactional provider that sends the one confirmation email. */
  emailProvider: configured(process.env.NEXT_PUBLIC_PDPP_EMAIL_PROVIDER, "email provider not set"),

  discordUrl: configured(process.env.NEXT_PUBLIC_PDPP_DISCORD_URL, "Discord URL not set"),
  mailingListUrl: configured(process.env.NEXT_PUBLIC_PDPP_MAILING_LIST_URL, "mailing list URL not set"),
} as const;

// The reports mailbox is NOT configurable: it is an LF Decentralized Trust
// address fixed by GOVERNANCE.md's own header, and a deployment that could
// point it elsewhere could silently redirect a conduct or security report.
export const REPORTS_EMAIL = "pdpp-dev-reports@lfdecentralizedtrust.org";

// Rendered verbatim under the signing form. Sentence supplied by the
// programme, with the controller interpolated from config so there is one
// place to change it when the transfer to LFDT happens.
export function signingDisclosure(): string {
  return `Your details are held by ${siteConfig.controllerName} on behalf of PDP-Connect until LF Decentralized Trust hosting is confirmed, and will be transferred then. We never publish your email.`;
}

/** Config values still on a placeholder, for the launch checklist. */
export function unsetConfigValues(): readonly string[] {
  return Object.entries(siteConfig)
    .filter(([, value]) => isPlaceholder(value))
    .map(([key]) => key);
}
