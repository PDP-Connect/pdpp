// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure data, deliberately split out of docs-source.ts: that module imports
// .source/server.ts (fumadocs-mdx, node:path) and is server-only, but
// components/specification/rail.tsx is a "use client" component that also needs to know which
// slugs are "supporting" so it can mark their links data-supporting. Importing
// docs-source.ts from rail.tsx pulled the server module into the client
// bundle and failed the build (UnhandledSchemeError on node:path).

// The nav label is "Specification", so the route is /specification. A label and
// its URL that disagree read as two destinations; /docs is kept alive as a
// permanent redirect (see next.config.mjs) so every link already published
// still resolves.
export const docsRoute = "/specification";

// The specification IS the page. The rail lists the normative core, the profile
// that accompanies it, and the three extension profiles — five documents, the
// whole of what the protocol normatively defines. Everything else the repository
// carries (guides, design rationale, deferred concerns, open questions, the
// superseded Data Query API) is still built, still routed, still linked, and
// still in the search index; it just does not compete with the spec for the
// rail. Nothing is deleted: drop a slug from this list and the page keeps its
// URL, it only stops appearing in the rail's primary list.
//
// Order is the reading order of the specification set, not alphabetical.
export const PRIMARY_SLUGS = [
  "spec-core",
  "spec-collection-profile",
  "spec-ext-lexical-search",
  "spec-ext-aggregation",
  "spec-semantic-retrieval-extension",
] as const;

// The supporting documents, in the order the specification-set table states
// them. These render as a quiet, unlabeled cluster at the foot of the rail
// (see components/specification/rail.tsx): reachable in one click, visibly subordinate, never a
// second peer list. A heading over them would make them a rival to the
// specification and put all ten documents back on equal footing.
export const SUPPORTING_SLUGS = [
  "spec-architecture",
  "spec-auth-design",
  "spec-change-tracking",
  "spec-connector-ecosystem",
  "spec-deferred",
  "open-questions",
  "reference-implementation",
  "reference-implementation-examples",
  "spec-data-query-api",
] as const;
