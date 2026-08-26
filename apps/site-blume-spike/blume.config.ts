import { defineConfig } from "blume";

export default defineConfig({
  content: { root: "content" },
  description: "A Blume rendering spike for canonical PDPP protocol material.",
  logo: "/brand/pdpp-mark.svg",
  navigation: {
    tabs: [
      { label: "Protocol", path: "/specification" },
      { label: "Governance", path: "/governance" },
      { label: "Self-host", path: "/self-host" },
      { label: "Participate", path: "/participate" },
    ],
  },
  seo: { sitemap: false },
  theme: { accent: "teal", radius: "sm" },
  title: "PDPP — Blume spike",
});
