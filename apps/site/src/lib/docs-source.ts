// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { docs } from "../../.source/server.ts";

// The nav label is "Specification", so the route is /specification. A label and
// its URL that disagree read as two destinations; /docs is kept alive as a
// permanent redirect (see next.config.mjs) so every link already published
// still resolves.
export const docsRoute = "/specification";

export const source = loader({
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
  source: docs.toFumadocsSource(),
});

export function getPageMarkdownUrl(page: InferPageType<typeof source>) {
  return {
    segments: page.slugs,
    url: `${page.url}.mdx`,
  };
}
