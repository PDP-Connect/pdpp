// source.config.ts
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";

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
  if (!lastChild || lastChild.type !== "text" || typeof lastChild.value !== "string") {
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

// source.config.ts
var docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true
    }
  },
  meta: {
    schema: metaSchema
  }
});
var source_config_default = defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkLegacyHeadingIds, ...plugins]
  }
});
export {
  source_config_default as default,
  docs
};
