// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Upstream Biome resolver false positives (see biome.jsonc's documented
// noUnresolvedImports override): fumadocs-core/fumadocs-mdx subpath exports
// Biome misreports as unresolved; both resolve cleanly under tsc and at build time.
// biome-ignore lint/correctness/noUnresolvedImports: see comment above.
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
// biome-ignore lint/correctness/noUnresolvedImports: see comment above.
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
// biome-ignore lint/correctness/noUnresolvedImports: see comment above.
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkLegacyHeadingIds } from "@/lib/remark-legacy-heading-ids.ts";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
    schema: pageSchema,
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkLegacyHeadingIds, remarkMdxMermaid, ...plugins],
  },
});
