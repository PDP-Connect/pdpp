// @ts-nocheck
import * as __fd_glob_15 from "../content/docs/spec-semantic-retrieval-extension.md?collection=docs"
import * as __fd_glob_14 from "../content/docs/spec-lexical-retrieval-extension.md?collection=docs"
import * as __fd_glob_13 from "../content/docs/spec-dti-alignment.md?collection=docs"
import * as __fd_glob_12 from "../content/docs/spec-deferred.md?collection=docs"
import * as __fd_glob_11 from "../content/docs/spec-data-query-api.md?collection=docs"
import * as __fd_glob_10 from "../content/docs/spec-core.md?collection=docs"
import * as __fd_glob_9 from "../content/docs/spec-connector-ecosystem.md?collection=docs"
import * as __fd_glob_8 from "../content/docs/spec-collection-profile.md?collection=docs"
import * as __fd_glob_7 from "../content/docs/spec-change-tracking.md?collection=docs"
import * as __fd_glob_6 from "../content/docs/spec-auth-design.md?collection=docs"
import * as __fd_glob_5 from "../content/docs/spec-architecture.md?collection=docs"
import * as __fd_glob_4 from "../content/docs/reference-implementation.md?collection=docs"
import * as __fd_glob_3 from "../content/docs/reference-implementation-examples.md?collection=docs"
import * as __fd_glob_2 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/README.md?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, }, {"README.md": __fd_glob_1, "index.mdx": __fd_glob_2, "reference-implementation-examples.md": __fd_glob_3, "reference-implementation.md": __fd_glob_4, "spec-architecture.md": __fd_glob_5, "spec-auth-design.md": __fd_glob_6, "spec-change-tracking.md": __fd_glob_7, "spec-collection-profile.md": __fd_glob_8, "spec-connector-ecosystem.md": __fd_glob_9, "spec-core.md": __fd_glob_10, "spec-data-query-api.md": __fd_glob_11, "spec-deferred.md": __fd_glob_12, "spec-dti-alignment.md": __fd_glob_13, "spec-lexical-retrieval-extension.md": __fd_glob_14, "spec-semantic-retrieval-extension.md": __fd_glob_15, });