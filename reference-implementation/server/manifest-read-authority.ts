// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Current-manifest authority for all read boundaries. */
export class ManifestReadAuthorityError extends Error {
  readonly code = "stream_not_declared";
  readonly statusCode = 404;

  constructor(stream: string | null) {
    super(
      stream
        ? `Stream '${stream}' is not declared by the current manifest`
        : "A current manifest is required to authorize this read"
    );
    this.name = "ManifestReadAuthorityError";
  }
}

type ManifestLike = { readonly streams?: readonly { readonly name?: unknown }[] } | null | undefined;
type GrantLike = { readonly streams?: readonly { readonly name?: unknown }[] } | null | undefined;
export type ManifestReadActor = "client" | "owner" | "internal";

export interface ManifestReadAuthorityOptions {
  readonly actor?: ManifestReadActor;
  /** Owner search filters are discovery filters, not an authority claim. */
  readonly ownerUnknownStream?: "empty" | "reject";
}

function declaredNames(manifest: ManifestLike): Set<string> {
  if (manifest == null || !Array.isArray(manifest.streams)) {
    throw new ManifestReadAuthorityError(null);
  }
  return new Set(
    manifest.streams.flatMap((entry) => (typeof entry?.name === "string" && entry.name ? [entry.name] : []))
  );
}

export function assertManifestReadAuthority(
  manifest: ManifestLike,
  stream: string,
  options: ManifestReadAuthorityOptions = {}
): void {
  const declared = declaredNames(manifest);
  if (!(declared.has(stream) || (options.actor === "owner" && options.ownerUnknownStream === "empty"))) {
    throw new ManifestReadAuthorityError(stream);
  }
}

export function assertGrantedManifestReadAuthority(
  manifest: ManifestLike,
  grant: GrantLike,
  _requestedStreams: readonly string[] | null | undefined
): void {
  const streams = (grant?.streams ?? []).flatMap((entry) => (typeof entry?.name === "string" ? [entry.name] : []));
  for (const stream of streams) {
    assertManifestReadAuthority(manifest, stream, { actor: "client" });
  }
}

export function assertOwnerSearchFilterAuthority(
  manifest: ManifestLike,
  streams: readonly string[] | null | undefined
): void {
  for (const stream of streams ?? []) {
    assertManifestReadAuthority(manifest, stream, { actor: "owner", ownerUnknownStream: "empty" });
  }
}
