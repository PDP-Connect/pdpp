// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal splice-by-offset string editor: collects a set of
 * non-overlapping [start, end) byte-range replacements against an
 * immutable original string, then materializes them in one pass. This
 * avoids the classic "apply replacement N, which shifts every subsequent
 * AST offset" bug that hand-rolled string splicing is prone to — every
 * offset recorded by a caller (from the original @babel/parser AST) stays
 * valid because replacements are only realized once, at `toString()` time,
 * against the ORIGINAL string's coordinate space.
 *
 * Named after (and API-compatible in spirit with, though not a full
 * reimplementation of) the well-known `magic-string` package — written
 * locally rather than added as a dependency because the surface this tool
 * needs is exactly two methods.
 */

export interface MagicString {
  overwrite: (start: number, end: number, replacement: string) => void;
  toString: () => string;
}

export function createMagicString(original: string): MagicString {
  const edits: { end: number; replacement: string; start: number }[] = [];
  return {
    overwrite(start: number, end: number, replacement: string): void {
      if (start < 0 || end > original.length || start > end) {
        throw new Error(`magic-string: invalid range [${start}, ${end}) for source of length ${original.length}`);
      }
      for (const existing of edits) {
        const overlaps = start < existing.end && end > existing.start;
        if (overlaps) {
          throw new Error(
            `magic-string: overlapping edits at [${start},${end}) and [${existing.start},${existing.end})`
          );
        }
      }
      edits.push({ start, end, replacement });
    },
    toString(): string {
      const sorted = [...edits].sort((a, b) => a.start - b.start);
      let result = "";
      let cursor = 0;
      for (const edit of sorted) {
        result += original.slice(cursor, edit.start);
        result += edit.replacement;
        cursor = edit.end;
      }
      result += original.slice(cursor);
      return result;
    },
  };
}
