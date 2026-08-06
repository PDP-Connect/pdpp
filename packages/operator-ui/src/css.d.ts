// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Ambient declaration so tsc accepts CSS side-effect imports (e.g.
// `import "./status-badge.css"`). The Next bundler handles the real import;
// tsc only needs a type for the module specifier. Same posture as
// @pdpp/brand-react/src/css.d.ts.
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}
