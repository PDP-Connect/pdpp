# Report-Issue CTA Prior Art and Recommendation

**Date:** 2026-06-19
**Scope:** Design-only. No code changes in this document.

---

## Current State in PDPP

The `code_fix` / `audience: "maintainer"` action is already wired. When a connector reaches
a terminal disposition with no owner-satisfiable recovery path, `rendered-verdict.ts` emits:

```
{ kind: "code_fix", audience: "maintainer", cta: "Connector code needs a fix" }
```

The connector detail page (`apps/console/src/app/dashboard/records/[connector]/page.tsx`)
handles it at line 1028. The function `connectorIssueHref` (line 1118) already builds a
prefilled GitHub issue URL targeting `https://github.com/vana-com/pdpp/issues/new`.

The **sources list row** (`connector-row.tsx`) does NOT surface this CTA -- it has no
`code_fix` branch. That is the dead-end gap the owner flagged.

---

## Prior Art Survey

### 1. GitHub's own prefilled new-issue URL

GitHub has supported query-param prefill since at least 2016:

```
https://github.com/<org>/<repo>/issues/new?title=<title>&body=<body>&labels=<label>
```

Parameters: `title`, `body`, `labels` (comma-separated), `assignees`, `template` (filename
of an issue template), `milestone`. All are optional. The URL opens a form pre-populated
but still editable -- the user submits, GitHub does not auto-file.

Source: GitHub Docs "Creating an issue"
(https://docs.github.com/en/issues/tracking-your-work-with-issues/creating-an-issue)

The pattern is intentionally shallow. Stripe's status page, Raycast's feedback widget,
Homebrew's `brew report` command, and VS Code's "Report Issue" command all converge on
this same URL shape rather than building a separate intake API. The reason: no auth
required from the tool, no webhook to maintain, the form gives the user a chance to add
context before filing.

### 2. VS Code "Report Issue"

VS Code's `Help > Report Issue` opens a prefilled GitHub new-issue URL. It prefills:

- Title: `[<extension name>] <user-typed summary>` (prompts user for one line)
- Body: OS, VS Code version, extension version, and a `### Steps to Reproduce` template

The key design choice: VS Code does NOT dump a wall of logs into the body. It puts version
metadata only and leaves structured placeholders. The user types the narrative. Source:
vscode repo `src/vs/workbench/contrib/issue/browser/issueReporter.ts`.

### 3. Sentry

Sentry's issue detail page has a "GitHub" integration that can create an issue from an
event. The prefilled body contains: error type, error message, stack trace (trimmed to
first 10 frames), and a link back to the Sentry event. Title is `<ErrorType>: <message>`.

The design lesson: Sentry does include a trace, but it trims aggressively and anchors
the body with a "View in Sentry" back-link so the receiver has a place to get more.
For PDPP the equivalent would be a link to the source detail page on the owner's instance
-- but since the instance is local and private, a link is not useful. Connector key +
manifest version is the right minimal substitute.

### 4. Raycast

Raycast's bug-report flow (accessible from the Command Palette) opens a URL:

```
https://github.com/raycast/raycast-extensions/issues/new?title=<extension>:+<summary>&body=<template>
```

The body template is:

```
**Description**
<!-- What happened? -->

**Steps to reproduce**
1.

**Raycast version:** 1.x.x
**macOS version:** 14.x
**Extension version:** 0.x.x
```

Minimal: three fields, one piece of version data per layer. No diagnostic dumps.

### 5. CLI tools (Homebrew, gh, cargo)

`brew report` and `gh issue create` (when run from an error handler) print a URL to
stdout or open the browser. The Homebrew formula for a broken tap includes:

```
brew gist-logs <formula>    # upload logs first, get a gist URL
brew report <formula>       # open issues/new with that gist URL in the body
```

Key pattern: separate the log-upload step from the issue-URL step. Only a short
identifier plus a link to fuller context goes in the body. The gist URL is the
PDPP equivalent of "link to the run trace" -- except PDPP runs are local/private, so
the analog is: connector key + connector version.

### 6. Linear public intake

Linear's public issue intake (used by teams who expose a public board) is a form, not a
URL. It is heavier: requires a hosted endpoint, email address, optional attachment. Not
relevant here -- PDPP has a public GitHub repo and a clear maintainer channel.

---

## Where the Repo URL Lives in PDPP

Connector manifests do NOT declare a `repo_url`, `issue_url`, or `source_url` field.
The only URL fields in manifests are `external_docs` (third-party docs, one connector)
and field-level `url` schema annotations.

The canonical repo is `https://github.com/vana-com/pdpp` derived from the git remote.
This is a convention, not a manifest field.

**Recommendation:** keep it a single hardcoded constant in the console, not a manifest
field. There is one issue tracker for all connectors; per-connector issue repos would
add manifest complexity with no benefit at current scale. If PDPP ever splits connectors
into separate repos, the right place to add `issue_url` is the manifest's top level.

---

## Minimal Prefilled-Issue URL Pattern (Recommended)

```
https://github.com/vana-com/pdpp/issues/new
  ?title=Connector+broken%3A+<connector_key>
  &body=<body>
  &labels=connector%2Cbug
```

Body (short, no wall of diagnostics):

```
**Connector:** <connector_key>  (e.g. `amazon`)
**Manifest version:** <version>  (e.g. `0.1.0`)

**What broke:**
-

**Expected:**
-
```

That is five lines plus two blank user-fill sections. The owner can add screenshots or a
run trace snippet if they want. Do not prefill more than this.

The existing `connectorIssueHref` function at `page.tsx:1118` already gets this right in
spirit. The only gap is:
1. The `connector` label is prefilled but `bug` is not -- minor; add it.
2. The body template says "A PDPP reference connector needs a code fix" as a prose
   sentence rather than a structured placeholder. Replacing that with the structured
   5-line block above makes it easier for a maintainer to triage.
3. The CTA does not appear on the **sources list row** -- only the detail page.

---

## Right Copy (One Line, One Button)

Button label: **"Report connector issue"**
No arrow, no explanation. The `title` attribute (tooltip) carries the privacy note that
is already present: "The generated issue includes only the connector type, not private
source labels or connection IDs."

Do not add surrounding prose. The action card's existing `cta` field already renders
"Connector code needs a fix" as a status line. The button is the escape hatch below it.

**Anti-patterns to avoid:**
- "We're on it" with no action -- dead end, implies work is in progress when it may not be.
- "Contact support" -- wrong channel for an open-source connector bug.
- Long explanatory text around the button -- adds cognitive load, delays the action.
- Auto-filing the issue (no user confirmation step) -- user should own the submission.

---

## Summary of Recommendation

1. The URL pattern is `github.com/vana-com/pdpp/issues/new?title=...&body=...&labels=connector,bug`.
   Keep it hardcoded; no manifest field needed.
2. The `connectorIssueHref` function already implements this. Tighten the body to a
   structured 5-line placeholder (connector key, manifest version, two fill sections).
3. Button label: "Report connector issue" (no arrow). Privacy tooltip stays.
4. Surface the button on the sources list row (connector-row.tsx), not only the detail
   page -- that is the dead-end location the owner identified.
5. No surrounding prose. The status line ("Connector code needs a fix") is sufficient
   context; the button is the single forward path.

---

## Citations

- GitHub new-issue URL params: https://docs.github.com/en/issues/tracking-your-work-with-issues/creating-an-issue
- VS Code issue reporter source: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/issue/browser/issueReporter.ts
- Raycast extension issue template: https://github.com/raycast/raycast-extensions/blob/main/.github/ISSUE_TEMPLATE/bug_report.md
- Homebrew `brew report`: https://github.com/Homebrew/brew/blob/master/Library/Homebrew/cmd/report.rb
- Current PDPP implementation: `apps/console/src/app/dashboard/records/[connector]/page.tsx` lines 1028-1042, 1118-1133
