// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"e2e-overview.md": () => import("../content/docs/e2e-overview.md?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "spec-architecture.md": () => import("../content/docs/spec-architecture.md?collection=docs"), "spec-auth-design.md": () => import("../content/docs/spec-auth-design.md?collection=docs"), "spec-change-tracking.md": () => import("../content/docs/spec-change-tracking.md?collection=docs"), "spec-collection-profile.md": () => import("../content/docs/spec-collection-profile.md?collection=docs"), "spec-connector-ecosystem.md": () => import("../content/docs/spec-connector-ecosystem.md?collection=docs"), "spec-core.md": () => import("../content/docs/spec-core.md?collection=docs"), "spec-data-query-api.md": () => import("../content/docs/spec-data-query-api.md?collection=docs"), "spec-deferred.md": () => import("../content/docs/spec-deferred.md?collection=docs"), "spec-dti-alignment.md": () => import("../content/docs/spec-dti-alignment.md?collection=docs"), "spec-e2e-examples.md": () => import("../content/docs/spec-e2e-examples.md?collection=docs"), }),
};
export default browserCollections;