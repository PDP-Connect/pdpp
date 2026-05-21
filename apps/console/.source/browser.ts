// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"README.md": () => import("../content/docs/README.md?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "reference-implementation-examples.md": () => import("../content/docs/reference-implementation-examples.md?collection=docs"), "reference-implementation.md": () => import("../content/docs/reference-implementation.md?collection=docs"), "spec-architecture.md": () => import("../content/docs/spec-architecture.md?collection=docs"), "spec-auth-design.md": () => import("../content/docs/spec-auth-design.md?collection=docs"), "spec-change-tracking.md": () => import("../content/docs/spec-change-tracking.md?collection=docs"), "spec-collection-profile.md": () => import("../content/docs/spec-collection-profile.md?collection=docs"), "spec-connector-ecosystem.md": () => import("../content/docs/spec-connector-ecosystem.md?collection=docs"), "spec-core.md": () => import("../content/docs/spec-core.md?collection=docs"), "spec-data-query-api.md": () => import("../content/docs/spec-data-query-api.md?collection=docs"), "spec-deferred.md": () => import("../content/docs/spec-deferred.md?collection=docs"), "spec-dti-alignment.md": () => import("../content/docs/spec-dti-alignment.md?collection=docs"), "spec-lexical-retrieval-extension.md": () => import("../content/docs/spec-lexical-retrieval-extension.md?collection=docs"), "spec-semantic-retrieval-extension.md": () => import("../content/docs/spec-semantic-retrieval-extension.md?collection=docs"), }),
};
export default browserCollections;