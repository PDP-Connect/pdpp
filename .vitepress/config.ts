import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'PDPP',
  description: 'Personal Data Portability Protocol',
  cleanUrls: true,
  srcExclude: ['local/**'],

  themeConfig: {
    nav: [
      { text: 'Spec', link: '/spec-core' },
      { text: 'Collection Profile', link: '/spec-collection-profile' },
    ],

    sidebar: [
      {
        text: 'Core Protocol',
        items: [
          { text: 'Introduction & Architecture', link: '/spec-core' },
          { text: 'Data Query API', link: '/spec-data-query-api' },
          { text: 'Auth Design', link: '/spec-auth-design' },
        ],
      },
      {
        text: 'Collection Profile',
        items: [
          { text: 'Collection Profile', link: '/spec-collection-profile' },
          { text: 'Connector Ecosystem', link: '/spec-connector-ecosystem' },
          { text: 'Architecture', link: '/spec-architecture' },
        ],
      },
      {
        text: 'Design Notes',
        items: [
          { text: 'Change Tracking', link: '/spec-change-tracking' },
          { text: 'DTI Alignment', link: '/spec-dti-alignment' },
          { text: 'E2E Examples', link: '/spec-e2e-examples' },
          { text: 'Deferred Concerns', link: '/spec-deferred' },
        ],
      },
      {
        text: 'E2E Artifacts',
        items: [
          { text: 'Overview', link: '/e2e/' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/vana-com/pdpp' },
    ],

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
    },
  },
})
