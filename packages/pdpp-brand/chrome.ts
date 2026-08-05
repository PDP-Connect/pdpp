// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SiteNavLink {
  readonly link: string;
  readonly text: string;
}

// Public-site nav: the spec, how to run it, and how the standard changes.
// Specification / Self-Host / Participate. Sandbox remains reachable from
// /reference but is not a top-level nav item — the masthead carries exactly
// three links. The owner console lives on its own deployed origin and uses
// clean top-level routes; public-site navigation does not carry an
// operator-console prefix.
//
// "Self-Host" rather than "Implementations": /reference is a product page whose
// job is to get someone running, and the front-door CTA reads "Self-host it".
// The nav label and the CTA have to be the same noun or the route looks like two
// different destinations. "Other implementations" survives as a section on that
// page, which is the part that genuinely is an inventory.
export const siteNav: readonly SiteNavLink[] = [
  { text: "Specification", link: "/docs" },
  { text: "Self-Host", link: "/reference" },
  { text: "Participate", link: "/participate" },
];
