// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { GITHUB_REPO_URL } from "@/components/pdpp-concept/site-facts.ts";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";

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
