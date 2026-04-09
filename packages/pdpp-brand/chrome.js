export const docsNav = [
  { text: 'Overview', link: '/' },
  { text: 'Spec', link: '/spec-core' },
  { text: 'Collection Profile', link: '/spec-collection-profile' },
  { text: 'Reference', link: process.env.PDPP_REFERENCE_URL ?? 'http://localhost:3000/reference' },
  { text: 'Design', link: process.env.PDPP_DESIGN_URL ?? 'http://localhost:3000/design' },
];

export const siteNav = [
  { text: 'Overview', link: '/' },
  { text: 'Docs', link: '/docs' },
  { text: 'Reference', link: '/reference' },
  { text: 'Design', link: '/design' },
];
