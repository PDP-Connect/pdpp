// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Title is rendered by SiteHeader above the docs layout; no sidebar title.
      title: null,
      url: "/",
    },
    githubUrl: "https://github.com/PDP-Connect/pdpp",
    themeSwitch: {
      component: <ThemeToggle />,
      enabled: true,
    },
  };
}
