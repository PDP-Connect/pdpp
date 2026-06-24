import type { MetadataRoute } from "next";

// The owner console is a dark-first installable app. Without this manifest the
// PWA used the public site's cream background, flashing a WHITE splash before
// the dark app painted. background_color/theme_color match the dark
// `--background` token (oklch(0.16 0.005 260) ≈ #0c0d0f) so the splash is dark
// from the first frame. Manifests cannot carry oklch(), hence the sRGB hex.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PDPP Owner Console",
    short_name: "PDPP",
    description: "Owner console for your PDPP reference instance — connections, runs, grants, and the record explorer.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0c0d0f",
    theme_color: "#0c0d0f",
    icons: [
      {
        src: "/brand/pdpp-favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
