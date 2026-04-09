// @ts-nocheck
import * as __fd_glob_12 from "../content/docs/spec-e2e-examples.md?collection=docs"
import * as __fd_glob_11 from "../content/docs/spec-dti-alignment.md?collection=docs"
import * as __fd_glob_10 from "../content/docs/spec-deferred.md?collection=docs"
import * as __fd_glob_9 from "../content/docs/spec-data-query-api.md?collection=docs"
import * as __fd_glob_8 from "../content/docs/spec-core.md?collection=docs"
import * as __fd_glob_7 from "../content/docs/spec-connector-ecosystem.md?collection=docs"
import * as __fd_glob_6 from "../content/docs/spec-collection-profile.md?collection=docs"
import * as __fd_glob_5 from "../content/docs/spec-change-tracking.md?collection=docs"
import * as __fd_glob_4 from "../content/docs/spec-auth-design.md?collection=docs"
import * as __fd_glob_3 from "../content/docs/spec-architecture.md?collection=docs"
import * as __fd_glob_2 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/e2e-overview.md?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, }, {"e2e-overview.md": __fd_glob_1, "index.mdx": __fd_glob_2, "spec-architecture.md": __fd_glob_3, "spec-auth-design.md": __fd_glob_4, "spec-change-tracking.md": __fd_glob_5, "spec-collection-profile.md": __fd_glob_6, "spec-connector-ecosystem.md": __fd_glob_7, "spec-core.md": __fd_glob_8, "spec-data-query-api.md": __fd_glob_9, "spec-deferred.md": __fd_glob_10, "spec-dti-alignment.md": __fd_glob_11, "spec-e2e-examples.md": __fd_glob_12, });