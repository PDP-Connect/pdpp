// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/components/pdpp-concept/site-facts.ts";
import { SPEC_STATUS } from "@/components/pdpp-concept/spec-status.ts";
import { source } from "@/lib/docs-source.ts";
import { buildSitemap } from "@/lib/sitemap-entries.ts";

// The URL-building/filtering logic lives in sitemap-entries.ts, which is pure
// and unit-tested (scripts/seo-metadata.test.ts). This file only supplies the
// real fumadocs page list — see sitemap-entries.ts for why the split exists.
export default function sitemap(): MetadataRoute.Sitemap {
  return buildSitemap(SITE_ORIGIN, source.getPages(), SPEC_STATUS.date);
}
