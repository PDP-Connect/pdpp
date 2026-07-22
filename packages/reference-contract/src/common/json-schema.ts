// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Structural JSON-Schema type shared by every schema in this package.
//
// Hand-authored to keep the dependency footprint narrow: AJV consumes any
// plain object, the OpenAPI generator does the same, and call sites benefit
// from inspecting the exact keywords we use rather than the full Draft-07
// vocabulary. Anything not listed is still permitted via the index
// signature, which is how vendor extensions (`x-...`) and emerging keywords
// stay pass-through.
//
// Lives in its own module to break the value-level cycle between
// ./index.ts (re-exports canonical helpers) and ./canonical.ts (depends on
// the structural type but must not depend on ./index.ts's runtime values).
export interface JsonSchema {
  $id?: string;
  additionalProperties?: boolean | JsonSchema;
  allOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  const?: unknown;
  description?: string;
  enum?: readonly unknown[];
  format?: string;
  items?: JsonSchema;
  maximum?: number;
  maxLength?: number;
  minimum?: number;
  minLength?: number;
  oneOf?: readonly JsonSchema[];
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  type?: string | string[];
  [extension: string]: unknown;
}
