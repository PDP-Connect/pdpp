// source.config.ts
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// src/lib/remark-legacy-heading-ids.ts
var LEGACY_ID_PATTERN = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;
function visit(node, visitor) {
  visitor(node);
  if (!node.children) {
    return;
  }
  for (const child of node.children) {
    visit(child, visitor);
  }
}
function applyLegacyId(node) {
  const lastChild = node.children?.[node.children.length - 1];
  if (lastChild?.type !== "text" || typeof lastChild.value !== "string") {
    return;
  }
  const match = lastChild.value.match(LEGACY_ID_PATTERN);
  if (!match) {
    return;
  }
  const [, id] = match;
  const cleaned = lastChild.value.replace(LEGACY_ID_PATTERN, "");
  lastChild.value = cleaned;
  node.data ??= {};
  node.data.id = id;
  node.data.hProperties = {
    ...node.data.hProperties ?? {},
    id
  };
}
function remarkLegacyHeadingIds() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type === "heading") {
        applyLegacyId(node);
      }
    });
  };
}

// src/lib/remark-note-asides.ts
var NOTE_LEAD_PATTERN = /^(Design axiom|Note\b.*):$/;
function leadTermOf(node) {
  const first = node.children?.[0];
  if (first?.type !== "strong") {
    return null;
  }
  const label = first.children?.[0];
  if (label?.type !== "text" || typeof label.value !== "string") {
    return null;
  }
  return label.value;
}
function isNoteParagraph(node) {
  const term = leadTermOf(node);
  return term !== null && NOTE_LEAD_PATTERN.test(term);
}
function remarkNoteAsides() {
  return (tree) => {
    for (const node of tree.children ?? []) {
      if (node.type === "paragraph" && isNoteParagraph(node)) {
        const paragraph = node;
        paragraph.data ??= {};
        paragraph.data.hName = "aside";
        paragraph.data.hProperties = {
          ...paragraph.data.hProperties ?? {},
          className: "pdpp-note"
        };
      }
    }
  };
}

// source.config.ts
var docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Webpack and Turbopack eagerly compile every MDX module in development.
    // spec-core.md is large enough that this exhausts the Node heap before the
    // specification route can render. Dynamic mode keeps frontmatter eager for
    // the page tree while compiling document bodies on demand at runtime.
    dynamic: true,
    postprocess: {
      includeProcessedMarkdown: true
    },
    schema: pageSchema
  },
  meta: {
    schema: metaSchema
  }
});
var source_config_default = defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkLegacyHeadingIds, remarkNoteAsides, remarkMdxMermaid, ...plugins],
    // Default remark-structure types index "tableCell" individually — every
    // cell of a row (an error code, its HTTP status, its category, its prose
    // description) becomes its own separate search-index entry with no
    // surrounding context, which is what produced bare `grant_id`/
    // `grant_expired` results with no sentence around them. "tableRow"
    // (dropped in favor of "tableCell" here) stringifies a whole row as one
    // block, so a search hit on an error code still carries the row's prose
    // description alongside it.
    remarkStructureOptions: {
      types: ["heading", "paragraph", "blockquote", "tableRow", "mdxJsxFlowElement"]
    }
  }
});
export {
  source_config_default as default,
  docs
};
