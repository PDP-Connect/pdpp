// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ThemeToggle } from "@/components/elements/theme-toggle.tsx";
import { GITHUB_REPO_URL } from "@/lib/site-facts.ts";

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: GITHUB_REPO_URL,
    nav: {
      // Title is rendered by SiteHeader above the docs layout; no sidebar title.
      title: null,
      url: "/",
    },
    themeSwitch: {
      component: <ThemeToggle />,
      enabled: true,
    },
  };
}

/** Spec layout: masthead owns search + theme; rail front matter owns GitHub. */
export function specDocsOptions(): BaseLayoutProps {
  return {
    nav: {
      title: null,
      url: "/",
    },
    themeSwitch: {
      enabled: false,
    },
  };
}
