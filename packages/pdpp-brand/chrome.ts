export interface SiteNavLink {
  readonly text: string;
  readonly link: string;
}

export const siteNav: readonly SiteNavLink[] = [
  { text: "Reference", link: "/reference" },
  { text: "Sandbox", link: "/sandbox" },
  { text: "Docs", link: "/docs" },
  { text: "Planning", link: "/planning" },
];
