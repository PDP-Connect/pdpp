import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PDPP Reference Dashboard",
    short_name: "PDPP",
    description: "Owner dashboard for PDPP connector runs, schedules, and pending interactions.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f8f6f0",
    theme_color: "#f8f6f0",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  };
}
