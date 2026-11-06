// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { siteFlags } from "./site-config.ts";

export interface PublicSiteNavChild {
  readonly link: string;
  readonly text: string;
}

export interface PublicSiteNavLink {
  /** Present on Specification and Participate. With two or more, the item opens a dropdown on hover/focus. */
  readonly children?: readonly PublicSiteNavChild[];
  readonly link: string;
  readonly text: string;
}

// Four intents, in the order a reader meets them: why the protocol exists,
// what it says, how to build on it, how to take part. Everything else on the
// site is reachable from inside one of those four.
//
// Specification carries a dropdown rather than a fifth nav item because the
// review period is temporary: "Review, extended" is a door into the same
// document, not a separate destination, and it disappears with reviewOpen
// without leaving a gap in the nav.
//
// Participate carries "Is your app on PDPP?" (/apps) the same way: the page is a
// view over the registers Participate already shows, so it is a door into that
// section, not a fifth intent.
//
// The review entry is the ONLY place outside /review and the reader's own
// version strip that the review period is named. That is deliberate: a
// deadline repeated across a site has to be unwound from every one of those
// places when it passes.
export function publicSiteNav(): readonly PublicSiteNavLink[] {
  const specificationChildren: PublicSiteNavChild[] = [{ link: "/specification", text: "The specification" }];

  if (siteFlags.reviewOpen) {
    specificationChildren.push({ link: "/review", text: "Review, extended" });
  }

  const participateChildren: PublicSiteNavChild[] = [
    { link: "/participate", text: "How to get involved" },
    { link: "/apps", text: "Is your app on PDPP?" },
  ];

  return [
    { link: "/principles", text: "Principles" },
    { children: specificationChildren, link: "/specification", text: "Specification" },
    { link: "/build", text: "Build" },
    { children: participateChildren, link: "/participate", text: "Participate" },
  ];
}
