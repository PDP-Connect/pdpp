// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// @pdpp/reference-contract
//
// Single source of truth for PDPP reference-implementation route manifests,
// schemas, validators, OpenAPI artifacts, and typed helpers.
//
// The package is JSON-Schema-first: every route exports a manifest with
// JSON-Schema request / response shapes. Those same schemas are consumed by:
//   - runtime request validation in the Express server (and later Fastify)
//   - OpenAPI generation (public + full artifacts)
//   - CLI / dashboard query builders
//   - tests

// biome-ignore-all lint/performance/noBarrelFile: this IS the package's public entry point — consumers import named members here by design. Individual subpath exports are available under "./common", "./public", etc. for call sites that want a narrower import.

export * from "./builders/index.ts";
export * from "./common/index.ts";
export * from "./public/index.ts";
export * from "./reference/index.ts";
export {
  getManifest,
  hasResponseSchema,
  listOperations,
  validateRequest,
  validateResponse,
} from "./validate.ts";
