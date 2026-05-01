/**
 * Pure path helpers used by `proxy.ts`.
 *
 * Lives in its own module so unit tests (`proxy.test.ts`) can exercise the
 * rewrite/alias logic without resolving `next/server`, which is only loadable
 * inside the Next.js bundler. The proxy `config.matcher` stays inline in
 * `proxy.ts` because Next statically analyses it and only accepts literals.
 */

// The advertised canonical sandbox API paths mirror the live PDPP reference
// (`/_ref/**`, `/.well-known/**`). App Router treats `_` as private and
// disallows `.`-prefixed directory segments, so the underlying handlers live
// at `/sandbox/ref/**` and `/sandbox/well-known/**` and the proxy rewrites
// the canonical URLs onto them. Direct hits on the underlying paths redirect
// to the canonical URLs so copied internal-looking links recover cleanly.
export function rewriteSandboxCanonicalPath(pathname: string): string | null {
  if (pathname === "/sandbox/_ref" || pathname.startsWith("/sandbox/_ref/")) {
    return `/sandbox/ref${pathname.slice("/sandbox/_ref".length)}`;
  }
  if (pathname === "/sandbox/.well-known" || pathname.startsWith("/sandbox/.well-known/")) {
    return `/sandbox/well-known${pathname.slice("/sandbox/.well-known".length)}`;
  }
  return null;
}

export function redirectSandboxAliasPath(pathname: string): string | null {
  if (pathname === "/sandbox/ref" || pathname.startsWith("/sandbox/ref/")) {
    return `/sandbox/_ref${pathname.slice("/sandbox/ref".length)}`;
  }
  if (pathname === "/sandbox/well-known" || pathname.startsWith("/sandbox/well-known/")) {
    return `/sandbox/.well-known${pathname.slice("/sandbox/well-known".length)}`;
  }
  return null;
}
