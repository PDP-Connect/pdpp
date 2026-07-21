/**
 * Schema tests for the LinkedIn connector.
 *
 * IMPORTANT: linkedin/index.ts does not yet emit any RECORD (Voyager
 * extraction is deferred; it emits SKIP_RESULT). So these fixtures are NOT
 * parser-derived — they are records shaped to the connector's MANIFEST stream
 * contract (manifests/linkedin.json). They prove the schema accepts the
 * declared contract and rejects representative drift, so the first real emit is
 * shape-checked. Whoever wires extraction MUST replace these with
 * fixture-proven records and tighten the id shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { educationSchema, experienceSchema, profileSchema, skillsSchema, validateRecord } from "./schemas.ts";

const PROFILE_RECORD = {
  id: "ACoAAA1b2c3d",
  full_name: "Alex Rivera",
  headline: "Staff Engineer at Acme",
  summary: "Builds reliable data infrastructure.",
  location: "San Francisco Bay Area",
  industry: "Software Development",
  public_url: "https://www.linkedin.com/in/alexrivera",
  current_position_title: "Staff Engineer",
  current_company: "Acme",
};

const EXPERIENCE_RECORD = {
  id: "exp-100",
  title: "Staff Engineer",
  company: "Acme",
  employment_type: "Full-time",
  start_date: "2021-03-01T00:00:00.000Z",
  end_date: null,
  location: "Remote",
  description: "Led the data platform team.",
};

const EDUCATION_RECORD = {
  id: "edu-200",
  school: "State University",
  degree: "B.S.",
  field_of_study: "Computer Science",
  start_date: "2013-09-01T00:00:00.000Z",
  end_date: "2017-06-01T00:00:00.000Z",
};

const SKILL_RECORD = {
  id: "skill-300",
  name: "Distributed Systems",
  endorsement_count: 42,
};

test("profile schema accepts a contract-shaped record", () => {
  const result = profileSchema.safeParse(PROFILE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("experience schema accepts a current role (null end_date)", () => {
  const result = experienceSchema.safeParse(EXPERIENCE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("education schema accepts a contract-shaped record", () => {
  const result = educationSchema.safeParse(EDUCATION_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("skills schema accepts a contract-shaped record", () => {
  const result = skillsSchema.safeParse(SKILL_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a non-URL public_url (parser captured a label)", () => {
  assert.equal(profileSchema.safeParse({ ...PROFILE_RECORD, public_url: "Alex Rivera" }).success, false);
});

test("skills schema rejects a missing name (manifest-required field)", () => {
  const { name: _omit, ...withoutName } = SKILL_RECORD;
  assert.equal(skillsSchema.safeParse(withoutName).success, false);
});

test("skills schema rejects a negative endorsement_count", () => {
  assert.equal(skillsSchema.safeParse({ ...SKILL_RECORD, endorsement_count: -1 }).success, false);
});

test("validateRecord routes all four streams and passes unknown streams through", () => {
  assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
  assert.equal(validateRecord("experience", EXPERIENCE_RECORD).ok, true);
  assert.equal(validateRecord("education", EDUCATION_RECORD).ok, true);
  assert.equal(validateRecord("skills", SKILL_RECORD).ok, true);
  assert.equal(validateRecord("recommendations", { id: "x" }).ok, true);
});
