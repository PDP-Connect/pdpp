/**
 * Zod schemas for LinkedIn stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom/schemas.ts):
 * linkedin/index.ts does NOT yet emit any RECORD — it is a browser scaffold
 * that verifies session reachability and emits
 * `SKIP_RESULT reason=linkedin_voyager_wiring_pending`. The Voyager API
 * extraction is deferred to a live session (LinkedIn is aggressively anti-bot,
 * so the connector is deliberately conservative). There is no observed emitted
 * shape; these schemas are derived from the connector's MANIFEST stream
 * declarations (manifests/linkedin.json) — the contract the connector commits
 * to emit once extraction lands.
 *
 * Wiring `validateRecord` now is the honest move: the first real emit is
 * shape-checked against the declared contract instead of silently trusted.
 * Whoever wires the Voyager extraction MUST re-verify these field shapes
 * against the real payload and tighten them — especially the id formats
 * (LinkedIn entity URNs vs. numeric ids), which the manifest leaves as opaque
 * strings. This file is a contract scaffold, not a fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex). Manifest declares date-time
// format on the date fields; accept an ISO-8601 datetime prefix.
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Opaque bounded id — LinkedIn entity ids are URNs or numeric; tighten when the
// real payload is observed.
const idSchema = z.string().min(1).max(200);
const isoDateTimeNullable = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime").nullable();

/**
 * profile stream (manifest required: id). One record: the owner's profile.
 * Every text field is free-form human content → pdppSafeText; public_url is a
 * URL.
 */
export const profileSchema = z.object({
  id: idSchema,
  full_name: pdppSafeText.max(300).nullable(),
  headline: pdppSafeText.max(1000).nullable(),
  summary: pdppSafeText.max(65_000).nullable(),
  location: pdppSafeText.max(300).nullable(),
  industry: pdppSafeText.max(300).nullable(),
  public_url: z.url().max(4096).nullable(),
  current_position_title: pdppSafeText.max(500).nullable(),
  current_company: pdppSafeText.max(500).nullable(),
});

/**
 * experience stream (manifest required: id). One record per role.
 */
export const experienceSchema = z.object({
  id: idSchema,
  title: pdppSafeText.max(500).nullable(),
  company: pdppSafeText.max(500).nullable(),
  employment_type: pdppSafeText.max(200).nullable(),
  start_date: isoDateTimeNullable,
  end_date: isoDateTimeNullable,
  location: pdppSafeText.max(300).nullable(),
  description: pdppSafeText.max(65_000).nullable(),
});

/**
 * education stream (manifest required: id). One record per school.
 */
export const educationSchema = z.object({
  id: idSchema,
  school: pdppSafeText.max(500).nullable(),
  degree: pdppSafeText.max(500).nullable(),
  field_of_study: pdppSafeText.max(500).nullable(),
  start_date: isoDateTimeNullable,
  end_date: isoDateTimeNullable,
});

/**
 * skills stream (manifest required: id, name). One record per skill.
 */
export const skillsSchema = z.object({
  id: idSchema,
  name: pdppSafeText.max(300),
  endorsement_count: z.number().int().min(0).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once Voyager extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  profile: profileSchema,
  experience: experienceSchema,
  education: educationSchema,
  skills: skillsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
