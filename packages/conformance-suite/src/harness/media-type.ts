// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Media-type validity for Core clause 4.8-1.

/**
 * IANA's registered top-level media types (RFC 6838 Section 4.2), plus the
 * `x-` experimental tree RFC 6838 Section 3.4 permits.
 *
 * Clause 4.8-1 says a record's `blob_ref.mime_type` "MUST be a valid IANA
 * media type". Validity here is structural — a registered top-level type, a `/`, and a subtype whose
 * characters RFC 6838 Section 4.2 allows. The suite deliberately does NOT
 * check the subtype against the live IANA registry: the registry changes
 * without a spec revision, so a suite that rejected an unregistered-but-well-
 * formed subtype would fail records that are valid tomorrow. What it
 * catches is the failure the clause is written against — a value that is not a
 * media type at all.
 */
const IANA_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set([
  "application",
  "audio",
  "example",
  "font",
  "haptics",
  "image",
  "message",
  "model",
  "multipart",
  "text",
  "video",
]);

/** RFC 6838 Section 4.2 `restricted-name`: an alphanumeric start, then a bounded set. */
const MEDIA_SUBTYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** The `x-` experimental tree: `x-` followed by an RFC 6838 `restricted-name` token. */
const EXPERIMENTAL_TYPE = /^x-[a-z0-9][a-z0-9!#$&^_.+-]{0,124}$/;

/** Whether `value` is structurally a valid IANA media type (clause 4.8-1). */
export function isValidMediaType(value: string): boolean {
  const [type, subtype, ...rest] = value.split("/");
  if (rest.length > 0 || type === undefined || subtype === undefined) {
    return false;
  }
  const lower = type.toLowerCase();
  const registered = IANA_TOP_LEVEL_TYPES.has(lower) || EXPERIMENTAL_TYPE.test(lower);
  // The subtype may carry parameters (`;charset=utf-8`); only the subtype
  // itself is name-checked, since the clause governs the media type's identity.
  const [bare] = subtype.split(";");
  return registered && bare !== undefined && MEDIA_SUBTYPE.test(bare);
}
