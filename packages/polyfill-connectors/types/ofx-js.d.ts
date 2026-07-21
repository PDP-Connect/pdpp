// ofx-js (0.2.x) ships no declaration file. Its shape has shifted across
// versions: sometimes top-level `OFX`, sometimes nested under `default`,
// sometimes a bare `parse`. We still import it as `unknown` and narrow
// structurally at the call site (see chase/index.ts parseQfxFile) — this
// shim just tells TypeScript "yes, the module exists" so the import line
// itself stops being an error. The call-site narrowing keeps us honest
// about the actual runtime shape.
declare module "ofx-js" {
  const mod: unknown;
  export default mod;
}
