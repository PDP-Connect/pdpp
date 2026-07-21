import { resolveAsUrl, resolveRsUrl } from './common.js';
import { discoverProvider } from './discovery.js';

export async function resolveReferenceAsUrl(flags) {
  if (flags['as-url'] || process.env.PDPP_AS_URL || process.env.AS_URL) {
    return resolveAsUrl(flags);
  }

  if (flags['rs-url'] || process.env.PDPP_RS_URL || process.env.RS_URL) {
    const discovered = await discoverProvider({
      ...flags,
      'rs-url': resolveRsUrl(flags),
    });
    return discovered.authorizationServer;
  }

  return resolveAsUrl(flags);
}
