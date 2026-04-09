import type { BaseLayoutProps, LinkItemType } from 'fumadocs-ui/layouts/shared';
import { siteNav } from '@pdpp/brand/chrome';

const VERSION = 'v0.1.0';

const navLinks: LinkItemType[] = siteNav.map((item) => ({
  type: 'main',
  text: item.text,
  url: item.link,
  active: item.link === '/' ? 'url' : 'nested-url',
}));

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="pdpp-docs-navtitle">
          <span className="pdpp-docs-navtitle__mark" aria-hidden="true">
            P
          </span>
          <span className="pdpp-docs-navtitle__brand">PDPP</span>
          <span className="pdpp-docs-navtitle__slash" aria-hidden="true">
            /
          </span>
          <span className="pdpp-docs-navtitle__label">Docs</span>
        </span>
      ),
      url: '/',
      children: (
        <span className="pdpp-docs-version" aria-label={`PDPP docs version ${VERSION}`}>
          {VERSION}
        </span>
      ),
    },
    links: navLinks,
    githubUrl: 'https://github.com/vana-com/pdpp',
  };
}
