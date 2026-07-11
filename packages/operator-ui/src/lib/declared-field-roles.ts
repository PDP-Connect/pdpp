/**
 * Declared presentation-ROLE seam (design.md §5.2, §5.3).
 *
 * TYPE (`field_capabilities[].type`: timestamp / currency / text / person / …)
 * says what a value IS. ROLE says which card SLOT a field fills: which `text`
 * field is the primary title vs the body, which timestamp is the event-time,
 * which field is the actor, which is the amount. TYPE never implies ROLE — two
 * `text` fields give no way to know which is the title — so a renderer that
 * promotes a field to a slot because of its type is guessing.
 *
 * This module is the CONSUMPTION SEAM, not the declaration source. It defines:
 *
 *   - `DeclaredFieldRoles` — a field-name → role map the renderer reads BEFORE
 *     any field-name heuristic, so a manifest-declared title/body/actor/amount
 *     wins by declaration.
 *   - `EMPTY_DECLARED_FIELD_ROLES` — the default a stream resolves to when it
 *     declares NO roles. The `x_pdpp_role` vocabulary is LIVE (review-approved
 *     2026-06-21): a manifest declares it via `schema.properties[field].x_pdpp_role`,
 *     the server surfaces it as `field_capabilities[].role`, and the assembler's
 *     `declaredRolesFromCapabilities` parses it (via `parseFieldRole`) into a
 *     `DeclaredFieldRoles` map. A stream with no declared roles resolves to this
 *     empty map, so the renderer falls to the honest generic key/value card for
 *     undeclared records. `parseFieldRole` validates the map: a typed card
 *     renders only from a declaration, never a field-name guess.
 *
 * It deliberately does NOT read any manifest surface or add any schema field —
 * it only types the read side of the contract so the rest of the presentation
 * layer is written against declared roles.
 */

/**
 * The minimal presentation-slot vocabulary (design.md §5.3). Every slot is
 * filled by DECLARATION; TYPE only gates formatting once a field is in a slot.
 */
export type FieldRole = "primary-title" | "secondary" | "event-time" | "actor" | "amount";

/**
 * A map of field name → declared presentation role for a stream. Read-only and
 * presentation-only: a renderer consults it to place fields into card slots,
 * never to alter filter, grant, or retrieval semantics. Only fields the
 * manifest declares a role for appear here; everything else falls to the
 * generic key/value table.
 */
export type DeclaredFieldRoles = Readonly<Record<string, FieldRole>>;

/**
 * The default: no declared roles. Until the role-declaration vocabulary lands
 * AND a manifest declares roles, this is what every stream resolves to, so the
 * renderer takes the honest generic fallback path for undeclared records.
 */
export const EMPTY_DECLARED_FIELD_ROLES: DeclaredFieldRoles = Object.freeze({});

/**
 * The first field in `data` whose declared role matches `role`, in declared
 * order. Conflict resolution per design.md §5.2: when two fields declare the
 * same role, the declared (object key) order decides; if NONE is declared,
 * `undefined` (the caller does NOT guess a fallback from field names — that is
 * the whole point of the seam).
 */
export function fieldForRole(roles: DeclaredFieldRoles, role: FieldRole): string | undefined {
  for (const [name, declared] of Object.entries(roles)) {
    if (declared === role) {
      return name;
    }
  }
  return;
}

/** True when the map declares at least one role (i.e. typed slots are available). */
export function hasDeclaredRoles(roles: DeclaredFieldRoles | null | undefined): boolean {
  return roles != null && Object.keys(roles).length > 0;
}

/**
 * The approved role vocabulary (design.md §5.3). Every value here has a live
 * renderer consumer: primary-title/secondary/actor (message + generic slots),
 * amount (money formatting), event-time (event-card body). `media-preview` and
 * `supporting-attribute` were PRUNED (review-approved 2026-06-22): both were inert —
 * media is driven by the server-typed blobAffordance path (not a presentation
 * role), and supporting-attribute's only effect was the generic key/value
 * default. A role that parses but does nothing is an inert promise; if a future
 * design needs a media or attribute-ordering role, add it WITH its renderer +
 * tests then.
 */
const VALID_FIELD_ROLES: ReadonlySet<string> = new Set<FieldRole>([
  "primary-title",
  "secondary",
  "event-time",
  "actor",
  "amount",
]);

/**
 * Validate a raw declared role string against the approved vocabulary. An UNKNOWN
 * role returns null (the field then falls to the generic fallback, NOT a guess —
 * review constraint #2: unknown/absent roles degrade to the honest generic fallback,
 * never field-name guessing). Presentation-only; never affects retrieval semantics.
 */
export function parseFieldRole(raw: unknown): FieldRole | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return VALID_FIELD_ROLES.has(trimmed) ? (trimmed as FieldRole) : null;
}
