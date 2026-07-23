// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: Preserves an established runtime, ordering, accessibility, or source-shape contract; verified by the package typecheck and build.
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
// biome-ignore lint/correctness/noUnresolvedImports: Preserves an established runtime, ordering, accessibility, or source-shape contract; verified by the package typecheck and build.
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
    remarkPlugins: (plugins) => [remarkLegacyHeadingIds, ...plugins],
  },
});
