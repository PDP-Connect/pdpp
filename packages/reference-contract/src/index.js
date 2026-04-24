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

export * from './common/index.ts';
export * from './public/index.ts';
export * from './reference/index.ts';
export * from './builders/index.ts';
export { validateRequest, listOperations } from './validate.ts';
