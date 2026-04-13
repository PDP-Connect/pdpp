import { defineConfig } from 'vitepress'
import { docsNav } from '@pdpp/brand/chrome'

export default defineConfig({
  title: 'PDPP',
  description: 'Personal Data Portability Protocol',
  cleanUrls: true,
  srcExclude: ['local/**', 'docs/**', 'apps/**', '.agents/**', '.claude/**', '**/.agents/**', '**/.claude/**', '**/SKILL.md'],
  ignoreDeadLinks: [/^\.\/reference\//],

  themeConfig: {
    nav: docsNav,

    sidebar: [
      {
        text: 'Normative Specifications',
        items: [
          { text: 'Core Protocol (v0.1.0)', link: '/spec-core' },
          { text: 'Collection Profile (v0.1.0)', link: '/spec-collection-profile' },
        ],
      },
      {
        text: 'Informational',
        items: [
          { text: 'Architecture Overview', link: '/spec-architecture' },
          { text: 'Auth Design', link: '/spec-auth-design' },
          { text: 'Connector Ecosystem', link: '/spec-connector-ecosystem' },
          { text: 'Change Tracking', link: '/spec-change-tracking' },
          { text: 'DTI Alignment', link: '/spec-dti-alignment' },
          { text: 'Deferred Concerns', link: '/spec-deferred' },
        ],
      },
      {
        text: 'Examples & Reference',
        items: [
          { text: 'E2E Examples', link: '/spec-e2e-examples' },
          { text: 'Data Query API (superseded)', link: '/spec-data-query-api' },
          { text: 'E2E Artifacts', link: '/e2e/' },
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
