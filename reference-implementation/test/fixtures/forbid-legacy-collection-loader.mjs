// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const serverModuleRoot = "/reference-implementation/server/";
const allowedServerModules = [
  "/server/core-source-authorization.ts",
  "/server/record-filters.ts",
  "/server/source-declaration.ts",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved.url.includes(serverModuleRoot) &&
    !allowedServerModules.some((allowed) => resolved.url.includes(allowed))
  ) {
    throw new Error(`Core-only runtime loaded a Collection module: ${resolved.url}`);
  }
  return resolved;
}
