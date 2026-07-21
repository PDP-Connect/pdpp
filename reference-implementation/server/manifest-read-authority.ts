/** Current-manifest authority for all grant-enforced reads. */
export class ManifestReadAuthorityError extends Error {
  readonly code = "stream_not_declared";
  readonly statusCode = 404;

  constructor(stream: string) {
    super(`Stream '${stream}' is not declared by the current manifest`);
    this.name = "ManifestReadAuthorityError";
  }
}

type ManifestLike = { readonly streams?: readonly { readonly name?: unknown }[] } | null | undefined;
type GrantLike = { readonly streams?: readonly { readonly name?: unknown }[] } | null | undefined;

function declaredNames(manifest: ManifestLike): Set<string> | null {
  if (manifest == null) {
    return null;
  }
  if (!Array.isArray(manifest.streams)) {
    return new Set();
  }
  return new Set(
    manifest.streams.flatMap((entry) => (typeof entry?.name === "string" && entry.name ? [entry.name] : []))
  );
}

export function assertManifestReadAuthority(manifest: ManifestLike, stream: string): void {
  const declared = declaredNames(manifest);
  if (declared !== null && !declared.has(stream)) {
    throw new ManifestReadAuthorityError(stream);
  }
}

export function assertGrantedManifestReadAuthority(
  manifest: ManifestLike,
  grant: GrantLike,
  requestedStreams: readonly string[] | null | undefined
): void {
  const streams =
    requestedStreams && requestedStreams.length > 0
      ? requestedStreams
      : (grant?.streams ?? []).flatMap((entry) => (typeof entry?.name === "string" ? [entry.name] : []));
  for (const stream of streams) {
    assertManifestReadAuthority(manifest, stream);
  }
}
