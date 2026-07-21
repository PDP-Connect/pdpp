/**
 * Deterministic field-label humanization for the honest generic card.
 *
 * Turns a raw field key (`net_pay`, `messageCount`, `HTTPStatus`) into a
 * readable Title-Case label ("Net pay", "Message count", "HTTP status"). This
 * is a LABEL transform ONLY — it is mechanical key-formatting, never evidence
 * of a field's type, role, or semantics. A field humanized to "Message count"
 * must NEVER cause a record to render as a `message` card; the humanized string
 * is display text, full stop (design.md §5.2 "Labels", §5.4).
 *
 * Prior art: JSON Schema's `title` annotation is the declared display label;
 * mechanical key-formatting is the documented LAST-RESORT fallback when no
 * declared label is present
 * (https://json-schema.org/understanding-json-schema/reference/annotations).
 *
 * When a manifest later declares a field label, that declared label is used
 * instead and this transform is bypassed — so this is the floor, not the goal.
 */

// Runs of uppercase acronyms ("HTTPStatus" → "HTTP Status"); camelCase humps
// ("messageCount" → "message Count"); and snake/kebab separators. All split
// boundaries; the result is collapsed to single spaces and Title-Cased.
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
const CAMEL_BOUNDARY = /([a-z\d])([A-Z])/g;
const SEPARATORS = /[\s_\-.]+/g;

/**
 * Humanize a raw field key into a Title-Case display label. Deterministic and
 * locale-stable (only ASCII case folding on the first letter of each word) so
 * SSR and client agree and tests can pin the output. Returns the trimmed raw
 * key unchanged when it carries no humanizable structure (already empty / all
 * punctuation), so an opaque key never becomes a blank label.
 */
export function humanizeFieldLabel(name: string): string {
  const spaced = name
    .replace(ACRONYM_BOUNDARY, "$1 $2")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .replace(SEPARATORS, " ")
    .trim();
  if (spaced.length === 0) {
    return name.trim();
  }
  const words = spaced.split(" ");
  return words
    .map((word, index) => {
      // Preserve an all-caps acronym ("HTTP", "URL", "ID") as-is.
      if (word.length > 1 && word === word.toUpperCase()) {
        return word;
      }
      // First word is sentence-cased; later words stay lowercase ("Net pay",
      // "Message count") — readable, not ALL Title Case, mirroring how product
      // UIs label form fields.
      if (index === 0) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word.toLowerCase();
    })
    .join(" ");
}
