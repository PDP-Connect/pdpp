/**
 * Zod schemas for GitHub stream records. Used for shape-check-before-emit.
 * Ground truth: parsers.ts record builders and local/samples/github.json.
 *
 * Six manifest-declared streams: user, repositories, starred, issues,
 * pull_requests, gists. Per-stream cursor varies by semantics.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Shared field schemas.
const idSchema = z.string().max(80); // numeric string from String(n.id)
const isoDateSchema = z.string().regex(ISO_DT_RE).nullable();
const urlSchema = z.string().max(4096).nullable();
const loginSchema = z.string().max(80).nullable();
const titleSchema = z.string().max(500).nullable();
const descriptionSchema = z.string().max(65_000).nullable();
const bodySchema = z.string().max(65_000).nullable(); // truncateBody caps at 20k
const numericSchema = z.number().int().nullable();
const booleanSchema = z.boolean();
const booleanNullableSchema = z.boolean().nullable();

/**
 * user stream: profile metadata. Cursor: created_at, updated_at.
 */
export const userSchema = z.object({
  id: idSchema,
  login: z.string().max(80),
  name: z.string().max(255).nullable(),
  email: z.string().max(255).nullable(),
  bio: z.string().max(160).nullable(),
  company: z.string().max(255).nullable(),
  location: z.string().max(255).nullable(),
  blog: z.string().max(1000).nullable(),
  twitter_username: z.string().max(80).nullable(),
  public_repos: numericSchema,
  public_gists: numericSchema,
  followers: numericSchema,
  following: numericSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  avatar_url: urlSchema,
});

/**
 * repositories stream: owned and org repos. Cursor: pushed_at.
 * Some records in production have sparse fields, so we use .optional()
 * to accept undefined in addition to null and valid values.
 */
export const repositoriesSchema = z.object({
  id: idSchema,
  name: z.string().max(255).optional(),
  full_name: z.string().max(255).optional(),
  owner_login: loginSchema.optional(),
  description: descriptionSchema.optional(),
  private: booleanNullableSchema.optional(),
  fork: booleanNullableSchema.optional(),
  archived: booleanNullableSchema.optional(),
  disabled: booleanNullableSchema.optional(),
  default_branch: z.string().max(255).nullable().optional(),
  language: z.string().max(80).nullable().optional(),
  topics: z.array(z.string().max(255)).nullable().optional(),
  stargazers_count: numericSchema.optional(),
  forks_count: numericSchema.optional(),
  open_issues_count: numericSchema.optional(),
  watchers_count: numericSchema.optional(),
  size_kb: numericSchema.optional(),
  license_key: z.string().max(50).nullable().optional(),
  html_url: urlSchema.optional(),
  homepage: urlSchema.optional(),
  created_at: isoDateSchema.optional(),
  updated_at: isoDateSchema.optional(),
  pushed_at: isoDateSchema.optional(),
});

/**
 * starred stream: simple star records with starred_at timestamp.
 */
export const starredSchema = z.object({
  id: idSchema,
  full_name: z.string().max(255),
  description: descriptionSchema,
  language: z.string().max(80).nullable(),
  stargazers_count: numericSchema,
  html_url: urlSchema,
  starred_at: isoDateSchema,
});

/**
 * issues stream: issues (and PRs marked as is_pull_request=true).
 * Cursor: updated_at.
 */
export const issuesSchema = z.object({
  id: idSchema,
  number: numericSchema,
  title: titleSchema,
  body: bodySchema,
  state: z.string().max(20).nullable(),
  state_reason: z.string().max(50).nullable(),
  user_login: loginSchema,
  user_id: idSchema.nullable(),
  assignees: z.array(z.string().max(80)).nullable(),
  labels: z.array(z.string().max(255)).nullable(),
  milestone_title: z.string().max(255).nullable(),
  repository_full_name: z.string().max(255).nullable(),
  repository_id: idSchema.nullable(),
  html_url: urlSchema,
  comments: numericSchema,
  reactions_total_count: numericSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  closed_at: isoDateSchema,
  is_pull_request: booleanSchema,
  pull_request_url: urlSchema,
  draft: booleanNullableSchema,
});

/**
 * pull_requests stream: PRs with detail fields.
 * Cursor: updated_at.
 */
export const pullRequestsSchema = z.object({
  id: idSchema,
  number: numericSchema,
  title: titleSchema,
  body: bodySchema,
  state: z.string().max(20).nullable(),
  state_reason: z.string().max(50).nullable(),
  user_login: loginSchema,
  user_id: idSchema.nullable(),
  assignees: z.array(z.string().max(80)).nullable(),
  labels: z.array(z.string().max(255)).nullable(),
  milestone_title: z.string().max(255).nullable(),
  repository_full_name: z.string().max(255).nullable(),
  repository_id: idSchema.nullable(),
  html_url: urlSchema,
  comments: numericSchema,
  reactions_total_count: numericSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  closed_at: isoDateSchema,
  draft: booleanSchema,
  merged_at: isoDateSchema,
  merged_by_login: loginSchema,
  commits_count: numericSchema,
  additions: numericSchema,
  deletions: numericSchema,
  changed_files: numericSchema,
  base_ref: z.string().max(255).nullable(),
  head_ref: z.string().max(255).nullable(),
  requested_reviewers: z.array(z.string().max(80)).nullable(),
  review_comments_count: numericSchema,
});

/**
 * gists stream: gist metadata + file listing.
 * Cursor: updated_at.
 */
export const gistsSchema = z.object({
  id: idSchema,
  description: descriptionSchema,
  public: booleanSchema,
  html_url: urlSchema,
  files: z
    .array(
      z.object({
        filename: z.string().max(255).nullable(),
        language: z.string().max(80).nullable(),
        size: numericSchema,
        raw_url: urlSchema,
      })
    )
    .nullable(),
  files_truncated: booleanSchema,
  files_total_count: numericSchema,
  comments_count: numericSchema,
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
});

/**
 * Schema registry: stream name → zod schema.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  user: userSchema,
  repositories: repositoriesSchema,
  starred: starredSchema,
  issues: issuesSchema,
  pull_requests: pullRequestsSchema,
  gists: gistsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
