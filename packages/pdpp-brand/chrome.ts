export interface SiteNavLink {
  readonly text: string;
  readonly link: string;
}

// Public-site nav, in narrative order: what it is → the spec → the server you
// can run → the live walkthrough. The owner console lives on its own deployed
// origin and uses clean top-level routes; public-site navigation does not carry
// an operator-console prefix.
export const siteNav: readonly SiteNavLink[] = [
  { text: "Docs", link: "/docs" },
  { text: "Host your own", link: "/reference" },
  { text: "Sandbox", link: "/sandbox" },
];
