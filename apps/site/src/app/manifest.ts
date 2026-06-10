import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PDPP",
    short_name: "PDPP",
    description:
      "Personal Data Polyfill Project — protocol docs, the reference-implementation explainer, and a mock-backed sandbox.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f8f6f0",
    theme_color: "#f8f6f0",
    // Only the App Router-generated /icon.svg (from src/app/icon.svg) is a real
    // asset on the public site. The previous PNG entries pointed at
    // public/*.png files that do not exist and are excluded by the root
    // `*.png` gitignore rule. The Apple touch icon is emitted separately by
    // src/app/apple-icon.tsx via Next's metadata file convention and does not
    // belong in the manifest icon list.
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
