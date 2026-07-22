// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SiteNavLink {
  readonly link: string;
  readonly text: string;
}

// Public-site nav, in narrative order: what it is → the spec → the server you
// can run → the live walkthrough. The owner console lives on its own deployed
// origin and uses clean top-level routes; public-site navigation does not carry
// an operator-console prefix.
export const siteNav: readonly SiteNavLink[] = [
  { link: "/docs", text: "Docs" },
  { link: "/reference", text: "Host your own" },
  { link: "/sandbox", text: "Sandbox" },
];
