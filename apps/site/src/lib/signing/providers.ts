// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const TRAILING_SLASH = /\/$/;

import "server-only";
import { type SignatoryRecord, SigningUnavailableError, type Submission } from "./index.ts";

// The three external seams: the short-lived store, the mail provider, and the
// private repository. Each is behind a named function so the route code reads
// as the flow it is, and so swapping a provider is one file.
//
// Every one of them FAILS CLOSED when unprovisioned: it throws
// SigningUnavailableError, which the routes turn into a 503 with no detail.
// The alternative — degrading to a no-op — would accept a signature, tell the
// signatory it worked, and drop it, which is the worst outcome available.
//
// This is PROVISIONED AND LIVE: the KV store, the mail provider and the
// fine-grained access token all exist, and real signatory records are being
// written. A preview deployment once wrote rehearsal records into the
// production register and a maintainer had to clean them out by hand, which is
// what `resolveRegisterBranch` below exists to prevent. Treat a change here as
// touching live personal data.

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SigningUnavailableError(`${name} is not set`);
  }
  return value;
}

// ---------------------------------------------------------------- pending store

// A pending submission lives here between the form post and the confirmation
// click, and nowhere else. It expires on its own, so an unconfirmed signature
// leaves no residue: that is the whole reason it is a TTL store and not the
// private repo.
const PENDING_TTL_SECONDS = 48 * 60 * 60;

interface KvConfig {
  token: string;
  url: string;
}

function kvConfig(): KvConfig {
  return { token: env("PDPP_KV_REST_API_TOKEN"), url: env("PDPP_KV_REST_API_URL").replace(TRAILING_SLASH, "") };
}

async function kvCommand(command: readonly (string | number)[]): Promise<unknown> {
  const { token, url } = kvConfig();
  const response = await fetch(`${url}/${command.map((part) => encodeURIComponent(String(part))).join("/")}`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new SigningUnavailableError(`pending store responded ${response.status}`);
  }
  const body = (await response.json()) as { result?: unknown };
  return body.result;
}

export async function putPending(id: string, submission: Submission): Promise<void> {
  await kvCommand(["set", `pending:${id}`, JSON.stringify(submission), "ex", PENDING_TTL_SECONDS]);
}

/** Reads a pending submission without consuming it. */
export async function readPending(id: string): Promise<Submission | null> {
  const raw = await kvCommand(["get", `pending:${id}`]);
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw) as Submission;
  } catch {
    return null;
  }
}

/** Consumes a pending submission only after its private record is durable. */
export async function deletePending(id: string): Promise<void> {
  await kvCommand(["del", `pending:${id}`]);
}

// ---------------------------------------------------------------- rate limit

const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX = 5;

/**
 * Per-IP fixed window. Returns false when the caller is over the limit.
 *
 * A fixed window lets a caller burst across a boundary, which for a form that
 * sends one email per submission is an acceptable trade for a counter that is
 * one INCR and cannot drift. The real cost being defended is outbound email,
 * not compute.
 */
export async function withinRateLimit(ip: string): Promise<boolean> {
  const key = `rate:${ip}`;
  const count = await kvCommand(["incr", key]);
  if (count === 1) {
    await kvCommand(["expire", key, RATE_LIMIT_WINDOW_SECONDS]);
  }
  return typeof count === "number" && count <= RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------- mail

/**
 * Sends the confirmation email.
 *
 * Both links are in this one message: confirming and withdrawing. That is why
 * no second email is needed to withdraw, and why the withdrawal path needs no
 * account, no password and no support request.
 */
export async function sendConfirmationEmail(options: {
  confirmUrl: string;
  to: string;
  withdrawUrl: string;
}): Promise<void> {
  const apiKey = env("PDPP_MAIL_API_KEY");
  const from = env("PDPP_MAIL_FROM");

  const text = [
    "You asked to sign the PDPP Principles.",
    "",
    "Open your confirmation page (this link expires in 48 hours and can be used once):",
    options.confirmUrl,
    "",
    "If you did not do this, ignore this email and nothing will be published.",
    "",
    "Keep this message. To withdraw at any time, use this link:",
    options.withdrawUrl,
  ].join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    body: JSON.stringify({
      from,
      subject: "Confirm your PDPP Principles signature",
      text,
      to: [options.to],
    }),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    throw new SigningUnavailableError(`mail provider responded ${response.status}`);
  }
}

// ---------------------------------------------------------------- private repo

// The private repository is reached with a token that has write access to that
// repository and nothing else. It is a Vercel secret and is never present in
// the public site repo.
//
// Commits are made by a bot identity with a message that says what happened
// and names no person: the commit LOG is metadata that a future maintainer
// reads, and a signatory's name in a commit subject is personal data in a
// place nobody thinks to redact.

/** The production register of record. The public publisher reads only this branch. */
const PRODUCTION_BRANCH = "signatures";

/** The disposable rehearsal branch. Started empty from private `main`, never published. */
const PREVIEW_BRANCH = "signatures-preview";

/**
 * Resolves the register branch from the deployment environment, or throws.
 *
 * A preview deployment that keeps the default branch writes rehearsal records
 * into the production register, and that already happened: the register had to
 * be cleaned by hand. The guard is the branch boundary, not an operator
 * convention, because the failure is silent — the journey succeeds, the record
 * is real, and it is only visible as an extra row in the published register.
 *
 * Every unrecognised Vercel state fails closed. A `VERCEL=1` deployment whose
 * `VERCEL_ENV` is missing or unknown is a deployment this policy has never seen.
 * `vercel dev` sets `VERCEL_ENV=development` and is therefore refused: there is
 * no `development` arm, so local development with live providers must run off
 * Vercel. Outside Vercel there is no environment to read, so the default stays
 * `signatures` for the non-Vercel production path; a live local rehearsal must
 * set `signatures-preview` explicitly.
 *
 * A rejection here is raised at write time, which on the confirm path is AFTER
 * the pending record has been read. On this branch's base that read is a
 * destructive GETDEL, so a rejection consumes the signatory's single-use link
 * and the submission cannot be retried. `fix/sign-form-error-ux` (#328) changes
 * confirm to read, write, then delete, which leaves the pending record intact
 * for a retry; `providers.test.ts` pins that ordering requirement.
 *
 * Pure, and exported, so every case can be checked without a deployment.
 */
export function resolveRegisterBranch(
  environment: { branch?: string; vercel?: string; vercelEnv?: string } = {}
): string {
  const branch = environment.branch?.trim() || PRODUCTION_BRANCH;
  const onVercel = (environment.vercel?.trim() ?? "") === "1";
  const vercelEnv = environment.vercelEnv?.trim() ?? "";

  if (!onVercel) {
    return branch;
  }
  if (vercelEnv === "production") {
    if (branch !== PRODUCTION_BRANCH) {
      throw new SigningUnavailableError(`production deployments write ${PRODUCTION_BRANCH}, not ${branch}`);
    }
    return branch;
  }
  if (vercelEnv === "preview") {
    if (branch !== PREVIEW_BRANCH) {
      throw new SigningUnavailableError(`preview deployments write ${PREVIEW_BRANCH}, not ${branch}`);
    }
    return branch;
  }
  throw new SigningUnavailableError(
    vercelEnv
      ? `VERCEL_ENV ${vercelEnv} has no register branch policy`
      : "VERCEL_ENV is not set, so no register branch policy applies"
  );
}

function repoConfig() {
  return {
    branch: resolveRegisterBranch({
      branch: process.env.PDPP_PRIVATE_REPO_BRANCH,
      vercel: process.env.VERCEL,
      vercelEnv: process.env.VERCEL_ENV,
    }),
    owner: env("PDPP_PRIVATE_REPO_OWNER"),
    repo: env("PDPP_PRIVATE_REPO_NAME"),
    token: env("PDPP_PRIVATE_REPO_TOKEN"),
  };
}

async function repoRequest(pathname: string, init: RequestInit): Promise<Response> {
  const { owner, repo, token } = repoConfig();
  return await fetch(`https://api.github.com/repos/${owner}/${repo}/${pathname}`, {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

const BOT = { email: "bot@pdpp.dev", name: "pdpp-supporters-bot" } as const;

function botCommitMessage(subject: string): string {
  return `${subject}\n\nSigned-off-by: ${BOT.name} <${BOT.email}>`;
}

async function ensureRepoBranch(branch: string): Promise<void> {
  const response = await repoRequest(`git/ref/heads/${encodeURIComponent(branch)}`, { method: "GET" });
  if (!response.ok) {
    throw new SigningUnavailableError(`private repo branch ${branch} is unavailable (${response.status})`);
  }
}

export async function writeSignatory(record: SignatoryRecord, filePath: string): Promise<void> {
  const { branch } = repoConfig();
  const response = await repoRequest(`contents/${filePath}`, {
    body: JSON.stringify({
      branch,
      committer: BOT,
      content: Buffer.from(JSON.stringify(record, null, 2)).toString("base64"),
      message: botCommitMessage(`Add signatory ${record.id}`),
    }),
    method: "PUT",
  });
  if (!response.ok) {
    throw new SigningUnavailableError(`private repo branch ${branch} responded ${response.status}`);
  }
}

/** Reads an existing private record to verify a racing confirmation was identical. */
export async function readSignatory(filePath: string): Promise<SignatoryRecord | null> {
  const { branch } = repoConfig();
  const response = await repoRequest(`contents/${filePath}?ref=${encodeURIComponent(branch)}`, { method: "GET" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new SigningUnavailableError(`private repo branch ${branch} responded ${response.status}`);
  }
  const file = (await response.json()) as { content?: string };
  if (!file.content) {
    throw new SigningUnavailableError("private repo returned an empty signatory record");
  }
  try {
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) as SignatoryRecord;
  } catch (error) {
    throw new SigningUnavailableError("private repo returned an invalid signatory record", { cause: error });
  }
}

/** Deletes a signatory file and appends the date, and only the date, to the log. */
export async function withdrawSignatory(id: string): Promise<boolean> {
  const { branch } = repoConfig();
  await ensureRepoBranch(branch);
  const year = new Date().getUTCFullYear();
  // The file is under the year it was confirmed in, which is not known here.
  // The candidate years are probed CONCURRENTLY rather than in sequence: they
  // are independent lookups, and walking them one at a time makes a withdrawal
  // as slow as the number of years the register has existed.
  const candidates = Array.from({ length: 6 }, (_, offset) => `signatories/${year - offset}/${id}.json`);
  const found = await Promise.all(
    candidates.map(async (filePath) => {
      const existing = await repoRequest(`contents/${filePath}?ref=${encodeURIComponent(branch)}`, { method: "GET" });
      if (!existing.ok) {
        return null;
      }
      const file = (await existing.json()) as { sha?: string };
      return file.sha ? { filePath, sha: file.sha } : null;
    })
  );

  const target = found.find((entry) => entry !== null);
  if (!target) {
    return false;
  }

  const deleted = await repoRequest(`contents/${target.filePath}`, {
    body: JSON.stringify({
      branch,
      committer: BOT,
      message: botCommitMessage(`Withdraw signatory ${id}`),
      sha: target.sha,
    }),
    method: "DELETE",
  });
  if (!deleted.ok) {
    throw new SigningUnavailableError(`private repo branch ${branch} responded ${deleted.status}`);
  }
  await appendWithdrawal();
  return true;
}

// The log records the DATE and nothing else. It exists so the size of the
// register over time can be accounted for; a reason, an id or an address in it
// would defeat the deletion it is recording.
async function appendWithdrawal(): Promise<void> {
  const { branch } = repoConfig();
  const existing = await repoRequest(`contents/withdrawn.log?ref=${encodeURIComponent(branch)}`, { method: "GET" });
  const previous = existing.ok ? ((await existing.json()) as { content?: string; sha?: string }) : null;
  const body = previous?.content ? Buffer.from(previous.content, "base64").toString("utf8") : "";
  const next = `${body}${new Date().toISOString().slice(0, 10)}\n`;

  const appended = await repoRequest("contents/withdrawn.log", {
    body: JSON.stringify({
      branch,
      committer: BOT,
      content: Buffer.from(next).toString("base64"),
      message: botCommitMessage("Record a withdrawal"),
      ...(previous?.sha ? { sha: previous.sha } : {}),
    }),
    method: "PUT",
  });
  if (!appended.ok) {
    throw new SigningUnavailableError(`private repo branch ${branch} responded ${appended.status}`);
  }
}
