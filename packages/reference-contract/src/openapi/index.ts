// OpenAPI generation entry point. Populated in W2.
// biome-ignore lint/performance/noBarrelFile: ./openapi is the package's named entry point for OpenAPI generation — call sites import generateOpenApi by name from here; the implementation lives in the sibling ./generate module.
export { generateOpenApi } from "./generate.ts";
