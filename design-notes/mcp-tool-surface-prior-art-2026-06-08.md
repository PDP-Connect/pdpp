# MCP Tool Surface Prior Art And Design Space

Status: decided
Owner: RI owner
Created: 2026-06-08
Updated: 2026-06-09
Related: openspec/changes/define-mcp-agent-entrypoint-surface; design-notes/mcp-tool-surface-token-footprint-2026-06-08.md; tmp/workstreams/mcp-tool-footprint-external-research.md

## Question

What is the full design space for reducing the model-loaded and user-facing MCP
tool surface, and what prior art supports or contradicts treating explicit
profiles as the SLVP ideal?

## Context

The reference MCP server had a live `tools/list` payload of about 49.6 KB across
14 tools. The prose-trimming tranche reduced that to about 38.5 KB, but kept one
flat topology. A follow-on OpenSpec change, now
`define-mcp-agent-entrypoint-surface`, initially proposed `core`, `events`, and
`full` surfaces. The proposal and design overstated the evidence by calling
profiles the SLVP ideal rather than one possible implementation mechanism.

The user requires greater than 95% confidence before we label any topology as
the SLVP ideal.

## Stakes

Tool topology affects recurring context cost, tool selection accuracy, setup
cognitive load, approval surfaces, and the risk of exposing mutating or
specialized capabilities to clients that only need grant-scoped reads.

It also affects host compatibility. Claude Code, Codex, ChatGPT/OpenAI Responses,
Cursor, VS Code, and generic MCP clients do not expose the same controls.

## Decision

Confidence is greater than 95% for the selected RI design: the recommended MCP
entrypoint is one profile-free normal read surface at `/mcp`.

Confidence is greater than 95% that `core` / `events` / `full` should not appear
in the final recommended setup UX. Profiles are incidental complexity for the
normal path and are not retained as hidden implementation machinery.

The selected normal surface contains exactly:

- `schema`
- `query_records`
- `aggregate`
- `search`
- `fetch`

Event-subscription management, blob retrieval, and developer/test tool surfaces
are outside normal MCP setup. If they return, they need a new explicit workflow
design rather than reusing profile taxonomy.

## Promoted To OpenSpec

Promoted into `openspec/changes/define-mcp-agent-entrypoint-surface`.

## Decision Log

- 2026-06-08: Prior-art pass found that profiles are not the only serious
  design option. Renamed the active change to
  `define-mcp-agent-entrypoint-surface` and added an RI owner gate requiring
  profiles to be classified as essential complexity or incidental complexity.
- 2026-06-08: Classified explicit profile taxonomy as incidental complexity for
  the recommended setup UX. Server-owned least-surface narrowing remains
  essential for generic MCP clients, but it should present as a normal
  intent-shaped endpoint/command, not a profile choice.
- 2026-06-08: RI owner pinned the final implementation design as one
  profile-free normal read entrypoint. Profiles are removed rather than retained
  for compatibility.
- 2026-06-09: Setup UX prior art confirmed the dashboard should expose one
  copy-paste page rather than pushing users through deployment diagnostics or
  owner-token issuance. Claude Code and Codex are command-shaped; ChatGPT,
  Claude.ai, and generic remote MCP clients are URL-shaped.

## Prior Art

### MCP protocol

The MCP tools spec defines `tools/list`, deterministic tool-list expectations,
authorization-shaped tool availability, and list-change notification. It also
states that `tools/list` supports pagination. The pagination utility page
confirms that `tools/list` is one of the paginated list operations.

Implication: pagination and `listChanged` are protocol support, but not a
complete answer to model-loaded context. Hosts can still fetch every page and
load all returned tools. The spec does, however, explicitly allow tool
availability to vary by the authorization presented on the request.

Sources:

- https://modelcontextprotocol.io/specification/draft/server/tools
- https://modelcontextprotocol.io/specification/draft/server/utilities/pagination

### OpenAI Responses and ChatGPT MCP

OpenAI's MCP guide shows that the API imports remote MCP tools through a
`mcp_list_tools` output item, can filter imported tools with `allowed_tools`, and
supports `defer_loading` when using tool search. OpenAI's data-only MCP guide
also treats `search` and `fetch` as the required read-only compatibility shape
for deep research and company knowledge.

Implication: OpenAI prior art points to three distinct mechanisms, not one:
compact read-only tool shapes, client-side `allowed_tools`, and host-native
deferred loading. A server profile is still useful for ChatGPT/developer setup,
generic clients, and capability minimization, but the ideal should compose with
host-native filtering and deferral rather than ignore them.

Sources:

- https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- https://developers.openai.com/api/docs/mcp
- https://developers.openai.com/api/docs/guides/tools-tool-search

### Codex

Codex supports stdio and streamable HTTP MCP servers, reads server
`instructions`, and exposes `enabled_tools` and `disabled_tools` in
`config.toml`. The documented setup model is shared across CLI and IDE
extension.

Implication: Codex can apply client-side allow/deny lists, but setup copy should
not require users to hand-edit a large list for normal use. The RI can give
Codex one recommended command for the default read entrypoint and optionally
document advanced tool filters for power users.

Source:

- https://developers.openai.com/codex/mcp

### Claude Code and Anthropic

Claude Code enables MCP tool search by default in supported environments:
schemas are deferred and discovered on demand. Anthropic's tool reference
documents `defer_loading`, and the advanced tool-use writeup argues for
on-demand discovery when tool libraries grow. Claude Code also supports
always-loaded server/tool exceptions.

Implication: for Claude Code, token footprint alone is no longer enough reason
to force every user onto a tiny profile. The design still needs capability
minimization and setup simplicity, but the best Claude Code setup may combine a
compact default entrypoint with host-native tool search or explicitly mark a
small high-use subset as always-loaded.

Sources:

- https://code.claude.com/docs/en/mcp
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://www.anthropic.com/engineering/advanced-tool-use
- https://code.claude.com/docs/en/agent-sdk/tool-search

### GitHub MCP

GitHub's official MCP server supports `--toolsets`, individual `--tools`,
read-only mode, and a tool-search CLI helper. GitHub docs also describe remote
toolset configuration with URL parameters or headers.

Implication: provider prior art strongly supports server-owned toolsets and
individual allow-lists. It also supports a capability grouping vocabulary, but
not necessarily the exact `core` / `events` / `full` profile names.

Sources:

- https://github.com/github/github-mcp-server
- https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets

### Stripe MCP

Stripe provides a hosted OAuth MCP server, local MCP setup, a tool catalog, MCP
session management in the dashboard, and restricted API key guidance for
agentic software.

Implication: Stripe's pattern is less about tool profiles and more about
authorization and permission scoping. PDPP can use the same idea more strongly:
grant shape should constrain what the MCP surface can do, and normal setup
should not ask for broad owner/control-plane credentials.

Source:

- https://docs.stripe.com/mcp

### Notion MCP

Notion exposes a broad hosted MCP tool catalog spanning search/fetch, content
creation, page updates, database/view operations, comments, and user/team
lookups. It notes that OpenAI MCP clients may see Notion's `notion-search` and
`notion-fetch` as `search` and `fetch` for deep-research compatibility.

Implication: Notion's current public docs prioritize a single hosted setup and
tool catalog. The relevant prior art for PDPP is the `search`/`fetch`
compatibility shape and concrete examples, not profile segmentation.

Source:

- https://developers.notion.com/guides/mcp/mcp-supported-tools

### Linear MCP

Linear documents a centrally hosted streamable HTTP MCP endpoint with OAuth/DCR,
client-specific setup commands for Claude Code and Codex, and support for
Bearer tokens/API keys in advanced cases. Its changelog says Linear reduced
token usage through better tool documentation.

Implication: Linear is strong prior art for simple setup UX and official hosted
OAuth MCP, but weak evidence for profiles. Its setup docs reinforce that a
PDPP setup page should provide one clear command per target client.

Sources:

- https://linear.app/docs/mcp
- https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management

### Setup UX for target hosts

Local CLI help for Claude Code and Codex both confirms the setup shape should
be one command per host:

- `claude mcp add --transport http <name> <url>` for an HTTP MCP server.
- `codex mcp add <name> --url <url>` for a streamable HTTP MCP server.

ChatGPT and Claude.ai style setup is UI-shaped: the operator creates or edits a
custom connector/app, pastes the remote MCP endpoint URL, uses OAuth, and lets
the host inspect tools. That supports a dashboard page whose first copy target
is `<origin>/mcp`, followed by exact commands only where the target host has a
stable command line.

Implication: the SLVP page is not a long runbook and not a token page. It is a
top-level "Connect an AI app" page that resolves the deployment origin, shows
the MCP URL first, shows Claude Code and Codex commands, and keeps CLI-first
scoped access plus `/llms.txt` as secondary entrypoints.

Sources:

- `codex mcp add --help` in the local environment.
- `claude mcp add --help` in the local environment.
- https://docs.anthropic.com/en/docs/claude-code/mcp
- https://developers.openai.com/codex/mcp

### Sentry MCP

Sentry states that its MCP tool selection is focused on human-in-the-loop coding
and debugging workflows rather than general-purpose Sentry coverage. It also
offers a Claude Code plugin/subagent lane and distinguishes AI-powered search
tools from other tools.

Implication: workflow-specialized surfaces and skills/subagents are legitimate
alternatives to broad generic tool catalogs. PDPP should consider whether some
workflows are better represented as agent skills, CLI commands, prompts, or
subagents rather than more MCP tools.

Source:

- https://github.com/getsentry/sentry-mcp

## Design Space

### 1. Flat list with shorter descriptions

This is useful hygiene but not sufficient as the ideal. It reduces bytes but
keeps all routing choices and capabilities in the normal model-visible surface.

Fit for PDPP: necessary baseline, not enough.

### 2. Server instructions plus compact tool docs

This moves repeated cross-tool guidance out of tool descriptions and improves
host routing where server instructions are read.

Fit for PDPP: keep it. It complements every other option.

### 3. Server-owned profiles or toolsets

Profiles/toolsets make the server expose only a selected capability group.
GitHub is the strongest prior art. PDPP's current `core`, `events`, and `full`
profiles are this pattern.

Fit for PDPP: rejected for the normal RI design. Future advanced workflows
should get explicit entrypoint design instead of reviving hidden profile
machinery.

### 4. Client-owned allow/deny lists

Codex has `enabled_tools` and `disabled_tools`. OpenAI Responses has
`allowed_tools`. This lets a host or operator narrow a broader server.

Fit for PDPP: useful advanced override, not the only default, because it creates
setup cognitive load if every ordinary user must choose tool names.

### 5. Host-native tool search and deferred loading

Claude Code and Anthropic support on-demand discovery. OpenAI Responses supports
deferred MCP loading through tool search.

Fit for PDPP: important. The final SLVP should not fight host-native deferral.
It should make tool names, descriptions, and server instructions work well when
tools are deferred.

### 6. Dynamic tool discovery or router tool

A server can expose a small search/router surface that reveals exact tools on
demand. GitHub has dynamic toolset discovery in beta; Anthropic and OpenAI have
host-native versions.

Fit for PDPP: possible future path, but not yet portable as a generic MCP
contract. Avoid inventing a non-standard dynamic layer until a clear host need
appears.

### 7. Split endpoints or split servers by workflow

Instead of profiles on one endpoint, the RI can expose separate read, event, and
developer servers or URLs.

Fit for PDPP: a possible future design for non-read workflows, not part of the
normal `/mcp` setup.

### 8. Grant- or permission-shaped `tools/list`

MCP permits tool availability to vary by authorization. PDPP grants already
define the stream/field/time shape of access. Stripe and Linear show
credential/scoping as a real-world setup lever.

Fit for PDPP: high value as a future refinement if non-read workflows return.
The current normal MCP surface is already read-only and grant-scoped.

### 9. Resources and prompts instead of tools

Some discoverable information may be better as MCP resources or prompts, not
tools. Claude Code exposes resources through `@` references and prompts as
commands.

Fit for PDPP: promising for schema/docs/setup help, but not a replacement for
read/query tools.

### 10. One broad operation-enum tool

One tool can collapse many operations behind an enum or action object.

Fit for PDPP: generally poor. It hides semantics inside a large schema, weakens
routing, and can increase cognitive load. A narrow router/search tool is
different and should be evaluated separately.

### 11. Agent skill, CLI, or subagent instead of MCP tool

Some workflows need procedural guidance more than another remote operation.
Sentry's plugin/subagent pattern is relevant here.

Fit for PDPP: good candidate for setup, troubleshooting, and multi-step operator
workflows. It should not replace the MCP read surface itself.

## Updated Confidence

Greater than 95% confidence:

- The default PDPP MCP setup should not expose every current read and event
  management tool as one always-loaded flat surface.
- Event-subscription management should not be part of the normal read/query
  path.
- Setup UX should show one recommended path before advanced variants.
- Owner/control-plane bearer tokens are not normal MCP setup credentials.
- The selected RI normal surface is one profile-free `/mcp` endpoint with
  exactly five read tools.
- Profiles should not remain as hidden compatibility machinery in this repo.

Not greater than 95% confidence:

- Whether a future non-read workflow should use a separate endpoint, an agent
  skill, a CLI path, resources/prompts, or grant-shaped dynamic tool exposure.
- Whether a future generic MCP client need justifies blob retrieval in normal
  setup.

Practical next move:

- Implement and gate `define-mcp-agent-entrypoint-surface` as the profile-free
  five-tool design.
- Keep setup UX to one recommended command/URL per client before any advanced
  verification copy.
