// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Upstream Biome resolver false positives (see biome.jsonc's documented
// noUnresolvedImports override): fumadocs-core/fumadocs-mdx subpath exports
// Biome misreports as unresolved; both resolve cleanly under tsc and at build time.
// biome-ignore lint/correctness/noUnresolvedImports: see comment above.
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
// biome-ignore lint/correctness/noUnresolvedImports: see comment above.
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkLegacyHeadingIds } from "@/lib/remark-legacy-heading-ids.ts";
import { remarkNoteAsides } from "@/lib/remark-note-asides.ts";

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
    remarkPlugins: (plugins) => [remarkLegacyHeadingIds, remarkNoteAsides, ...plugins],
    // Default remark-structure types index "tableCell" individually — every
    // cell of a row (an error code, its HTTP status, its category, its prose
    // description) becomes its own separate search-index entry with no
    // surrounding context, which is what produced bare `grant_id`/
    // `grant_expired` results with no sentence around them. "tableRow"
    // (dropped in favor of "tableCell" here) stringifies a whole row as one
    // block, so a search hit on an error code still carries the row's prose
    // description alongside it.
    remarkStructureOptions: {
      types: ["heading", "paragraph", "blockquote", "tableRow", "mdxJsxFlowElement"],
    },
  },
});
