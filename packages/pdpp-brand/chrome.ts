// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SiteNavLink {
  readonly link: string;
  readonly text: string;
}

// Public-site nav: the spec, the implementations that realize it, and how the
// standard changes. Matches the PDPP document register (DESIGN-SPEC.md):
// Specification / Implementations / Participate. Sandbox remains reachable
// from the homepage's doors list and from /reference, but is not a top-level
// nav item — the concept's masthead carries exactly three links. The owner
// console lives on its own deployed origin and uses clean top-level routes;
// public-site navigation does not carry an operator-console prefix.
export const siteNav: readonly SiteNavLink[] = [
  { text: "Specification", link: "/docs" },
  { text: "Implementations", link: "/reference" },
  { text: "Participate", link: "/participate" },
];
