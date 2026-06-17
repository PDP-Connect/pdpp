export interface SiteNavLink {
  readonly text: string;
  readonly link: string;
}

// Public-site nav, in narrative order: what it is → the spec → the server you
// can run → the live walkthrough. `/dashboard` is the operator console (separate
// origin) and is filtered out of the public header; it stays here as the shared
// brand source of truth. The self-hostable reference server is presented to
// visitors as "Host your own" (a runnable product), while docs/operator pages
// keep the precise "reference implementation / Personal Data Server" terminology.
export const siteNav: readonly SiteNavLink[] = [
  { text: "Dashboard", link: "/dashboard" },
  { text: "Docs", link: "/docs" },
  { text: "Host your own", link: "/reference" },
  { text: "Sandbox", link: "/sandbox" },
];
