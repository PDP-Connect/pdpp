import type { BaseLayoutProps, LinkItemType } from 'fumadocs-ui/layouts/shared';
import { siteNav } from '@pdpp/brand/chrome';

const navLinks: LinkItemType[] = siteNav.map((item) => ({
  type: 'main',
  text: item.text,
  url: item.link,
  active: item.link === '/' ? 'url' : 'nested-url',
}));

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'PDPP',
      url: '/',
    },
    links: navLinks,
    githubUrl: 'https://github.com/vana-com/pdpp',
  };
}
