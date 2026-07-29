// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Upstream Biome resolver false positive (see biome.jsonc's documented
// noUnresolvedImports override): tailwindcss has an `exports` field Biome
// misreports as unresolved; resolves cleanly under tsc and at build time.
// biome-ignore lint/correctness/noUnresolvedImports: see comment above.
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
};

export default config;
