// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import "server-only";
import { z } from "zod";

// The interim Supporter signing system, server side.
//
// THREAT MODEL, because every decision below follows from it. The public form
// is unauthenticated and reachable by anyone. The things that must not happen
// are: someone signing in another person's name; someone signing on behalf of
// an organisation they have no connection to; the register filling with junk;
// and personal data reaching the public repository. Everything here exists for
// one of those four.
//
// Nothing in this file is exercised by a test or a live run yet: the KV store,
// the mail provider and the deploy key do not exist until they are provisioned.
// It is written to FAIL CLOSED at every seam rather than to degrade, so the
// unprovisioned state is a refusal with a clear reason and never a silent
// half-write.

// ---------------------------------------------------------------- environment

// Server-only. None of these are NEXT_PUBLIC_, so none reach the browser
// bundle. Read lazily rather than at module load: a missing variable should
// fail the request that needs it with a nameable error, not the whole build.
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SigningUnavailableError(`${name} is not set`);
  }
  return value;
}

/** Thrown when the system is not provisioned. Never leaks to the client body. */
export class SigningUnavailableError extends Error {
  override name = "SigningUnavailableError";
}

/** Thrown when the submission itself is bad. Its message IS shown. */
export class SigningRejectedError extends Error {}

// ---------------------------------------------------------------- validation

// Free-text fields are length-capped because they end up in a filename, a
// commit message and a rendered page. `.trim()` before every check so a field
// of spaces cannot pass a min-length.
const personName = z.string().trim().min(1).max(120);

// Deliberately not a full RFC 5322 parser: the confirmation email is the real
// check, and an over-clever pattern rejects valid addresses. This only rules
// out shapes that cannot be an address at all.
const email = z.string().trim().toLowerCase().min(3).max(254).email();

const COUNTRIES = ["Australia", "Germany", "Netherlands", "Switzerland", "United Kingdom", "United States"] as const;

const ORGANISATION_TYPES = ["Company", "Platform", "Research institute", "Civil society", "Public body"] as const;

// A checkbox that was ticked arrives as "on"; an unticked one is absent.
const consented = z.literal("on").transform(() => true);
const optionalConsent = z.union([z.literal("on"), z.undefined()]).transform((value) => value === "on");

const individualSubmission = z.object({
  signatory_kind: z.literal("individual"),
  name: personName,
  email,
  affiliation: z.string().trim().max(160).optional(),
  country: z.enum(COUNTRIES),
  principles_version: z.string().trim().max(16),
  // Both are REQUIRED for an individual: one is the signature itself, the
  // other is consent to publish. A submission missing either is not a
  // signature we may act on.
  consent_principles: consented,
  consent_register: consented,
  consent_age: consented,
  consent_updates: optionalConsent,
});

const organisationSubmission = z.object({
  signatory_kind: z.literal("organisation"),
  name: personName,
  email,
  organisation: personName,
  organisation_type: z.enum(ORGANISATION_TYPES),
  country: z.enum(COUNTRIES),
  principles_version: z.string().trim().max(16),
  consent_principles: consented,
  consent_register: consented,
  consent_authority: consented,
  consent_updates: optionalConsent,
});

export const submissionSchema = z.discriminatedUnion("signatory_kind", [individualSubmission, organisationSubmission]);

export type Submission = z.infer<typeof submissionSchema>;

// Free mailbox providers an organisation signature may not come from. The rule
// in the brief is that an organisation signs from an address at its own
// domain; this list is what makes "its own domain" mean something, because
// otherwise a free-mailbox address claiming an organisation named after that
// mailbox provider would pass a naive domain comparison.
const PUBLIC_MAILBOX_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "yandex.com",
]);

/** Normalises an organisation name to the shape a domain label would take. */
const NON_ALPHANUMERIC = /[^a-z0-9]/g;
const HYPHENS = /-/g;
const WHITESPACE = /\s+/;

function organisationSlug(organisation: string): string {
  return organisation.toLowerCase().normalize("NFKD").replace(NON_ALPHANUMERIC, "");
}

function oneContainsOther(left: string, right: string): boolean {
  return left.indexOf(right) !== -1 || right.indexOf(left) !== -1;
}

// An organisation submission must come from an address at the organisation's
// own domain. This is intentionally a WEAK check that refuses the obvious
// cases rather than a strong one that would refuse legitimate signatures: a
// company whose domain genuinely differs from its trading name is common, and
// the confirmation email plus the maintainers' review are the real controls.
// What it does catch is the free-mailbox case and the plainly unrelated
// domain, which is the abuse it exists for.
export function organisationDomainMatches(submission: Submission): boolean {
  if (submission.signatory_kind !== "organisation") {
    return true;
  }
  const [, domain] = submission.email.split("@");
  if (!domain || PUBLIC_MAILBOX_DOMAINS.has(domain)) {
    return false;
  }
  const slug = organisationSlug(submission.organisation);
  const domainLabels = new Set(domain.split(".").map((label) => label.replace(HYPHENS, "")));
  // The organisation name matches a domain label, or a domain label is
  // contained in the organisation name (so "acme.io" matches "Acme
  // Technologies") — either direction, because both are ordinary.
  for (const label of domainLabels) {
    if (label.length > 2 && oneContainsOther(slug, label)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- public name

/**
 * The name that appears on the public register.
 *
 * Individuals are published as first name and last initial, organisations by
 * organisation name. This is computed ONCE, here, and stored alongside the
 * record, rather than derived when the register is published: if the rule ever
 * changes, everyone who already signed keeps the name they were shown when
 * they consented to be listed.
 */
export function computePublicName(submission: Submission): string {
  if (submission.signatory_kind === "organisation") {
    return submission.organisation;
  }
  const parts = submission.name.split(WHITESPACE).filter(Boolean);
  const first = parts[0] ?? submission.name;
  const last = parts.length > 1 ? parts.at(-1) : undefined;
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

// ---------------------------------------------------------------- signed links

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export type TokenPurpose = "confirm" | "withdraw";

interface TokenPayload {
  expiresAt: number;
  id: string;
  purpose: TokenPurpose;
}

function tokenSecret(): string {
  return requireEnv("PDPP_SIGNING_TOKEN_SECRET");
}

function sign(value: string): string {
  return createHmac("sha256", tokenSecret()).update(value).digest("base64url");
}

/** A single-use link payload: opaque id, purpose, and an absolute expiry. */
export function createToken(id: string, purpose: TokenPurpose, now = Date.now()): string {
  const payload: TokenPayload = { id, purpose, expiresAt: now + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Verifies a link. Returns null for anything wrong, without saying which
 * thing: a caller that could distinguish "bad signature" from "expired" from
 * "wrong purpose" is an oracle.
 *
 * Single use is NOT enforced here. It cannot be: a signature check is
 * stateless. The store is what burns the token, and the routes do that before
 * they act on it.
 */
export function verifyToken(token: string, purpose: TokenPurpose, now = Date.now()): string | null {
  const [body, signature] = token.split(".");
  if (!(body && signature)) {
    return null;
  }
  const expected = sign(body);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (payload.purpose !== purpose || payload.expiresAt < now) {
      return null;
    }
    return payload.id;
  } catch {
    return null;
  }
}

export function newSubmissionId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------- the record

/**
 * What is written to the PRIVATE repository, one file per signatory.
 *
 * Everything a signatory gave, plus what was computed at the moment they
 * consented. The public register is derived from this by the publish script,
 * which copies only five of these fields; nothing else has a route out.
 */
export interface SignatoryRecord {
  confirmedAt: string;
  consent: {
    principles: boolean;
    register: boolean;
    updates: boolean;
    ageOrAuthority: boolean;
  };
  country: string;
  displayName: string;
  email: string;
  id: string;
  organisation: string | null;
  principlesVersion: string;
  publicName: string;
  signatoryName: string | null;
  signatoryRole: string | null;
  type: string;
}

export function buildRecord(id: string, submission: Submission, confirmedAt = new Date()): SignatoryRecord {
  const isOrganisation = submission.signatory_kind === "organisation";
  return {
    id,
    displayName: submission.name,
    publicName: computePublicName(submission),
    organisation: isOrganisation ? submission.organisation : (submission.affiliation ?? null),
    signatoryName: isOrganisation ? submission.name : null,
    signatoryRole: null,
    email: submission.email,
    country: submission.country,
    type: isOrganisation ? submission.organisation_type : "Individual",
    consent: {
      principles: submission.consent_principles,
      register: submission.consent_register,
      updates: submission.consent_updates,
      ageOrAuthority: isOrganisation ? submission.consent_authority : submission.consent_age,
    },
    principlesVersion: submission.principles_version,
    confirmedAt: confirmedAt.toISOString(),
  };
}

/** `signatories/<yyyy>/<id>.json`, per the interim architecture. */
export function recordPath(record: SignatoryRecord): string {
  return `signatories/${record.confirmedAt.slice(0, 4)}/${record.id}.json`;
}

/**
 * Conflicting writes may have different confirmation timestamps. All other
 * fields are the immutable statement the signatory confirmed.
 */
export function hasSameImmutableFields(expected: SignatoryRecord, actual: SignatoryRecord): boolean {
  const { confirmedAt: _expectedConfirmedAt, ...expectedFields } = expected;
  const { confirmedAt: _actualConfirmedAt, ...actualFields } = actual;
  return JSON.stringify(expectedFields) === JSON.stringify(actualFields);
}
