// Ambient declaration so tsc accepts the per-component CSS side-effect imports
// (e.g. `import "./components.css"`). The Next bundler handles the real import;
// tsc only needs a type for the module specifier. Mirrors
// apps/console/src/types/css.d.ts, which previously covered these imports while
// the components lived under the app tree.
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}
