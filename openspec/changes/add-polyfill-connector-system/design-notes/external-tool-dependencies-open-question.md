# Open question: external-tool dependencies (subprocess binaries)

**Status:** partially decided
**Raised:** 2026-04-19
**Trigger:** the Slack connector requires `slackdump` on PATH. The Collection Profile spec had no concept for this class of dependency, so the requirement was invisible to the runtime, the consent card, and the user.
**Decision:** `openspec/changes/declare-polyfill-external-tools` adopts Option A as static manifest metadata. Runtime execution of `detect.command` and `setup_required` interactions remain deferred.

## Three classes of dependency, only one is spec'd

| Class | Example | Spec'd today? |
|---|---|---|
| 1. Runtime bindings | `network`, `filesystem`, `interactive` | ✅ yes — `runtime_requirements.bindings` |
| 2. Language-level deps | npm packages, Go modules, Python imports | ❌ no — implicit in the connector package |
| 3. External tool binaries | `slackdump`, `osxphotos`, `ffmpeg`, `pandoc`, `playwright` browsers | ✅ static manifest metadata via `runtime_requirements.external_tools`; runtime preflight deferred |

Class 1 is declared by the manifest and enforced by the runtime. Classes 2 and 3 are implementation concerns today. That's fine for (2) — every polyfill-runtime can assume its connectors resolve their own language deps. It's problematic for (3) because the runtime has no way to:

- Refuse to spawn a connector whose external tools aren't installed.
- Tell the user what they need to install before granting.
- Show license implications of the transitive dependency (e.g. AGPL slackdump).
- Audit supply-chain surface of a connector deployment.

## Concrete cases in our fleet

| Connector | External tool | License | Why it's needed |
|---|---|---|---|
| slack | `slackdump` | AGPL-3.0 | Session-token Slack export |
| imessage | none today; could benefit from `osxphotos` for attachment metadata | MIT | Attachment resolution |
| apple_health | none today; `xml2csv` or custom | varies | Parsing Apple's export XML |
| any browser-scraper | Playwright browsers (~400MB) | Apache-2.0 | Scrape via Chromium |
| future: icloud_photos | `pyicloud` or `osxphotos` | MIT | iCloud photo library access |
| future: ffmpeg-using media | `ffmpeg` | LGPL/GPL | Video/audio transcoding |

Before `declare-polyfill-external-tools`, all of these silently failed at runtime with cryptic errors if the binary was missing. Slack now declares `slackdump`; runtime preflight is still deferred.

## What the spec could add

### Option A: `runtime_requirements.external_tools` as first-class field

```json
"runtime_requirements": {
  "bindings": { "network": {}, "filesystem": { "required": true } },
  "external_tools": [
    {
      "name": "slackdump",
      "min_version": "3.0.0",
      "license": "AGPL-3.0",
      "purpose": "Session-token Slack export",
      "install_hint": "go install github.com/rusq/slackdump/v3/cmd/slackdump@latest",
      "detect": { "command": "slackdump --help", "exit_code": 0 }
    }
  ]
}
```

Runtime checks `detect` at spawn; if any tool is missing, emit INTERACTION kind=setup_required with install hints or fail the run cleanly.

**Pro:** explicit, license-visible in consent card, discoverable for auditors.
**Con:** new spec surface, `detect` is an executable-from-runtime concept that crosses the sandbox boundary.

### Option B: "subprocess" as a new binding kind

```json
"bindings": {
  "subprocess": { "name": "slackdump", "min_version": "3.0.0" }
}
```

Treats a subprocess binary as a runtime-provided capability, like network or filesystem. Runtime can choose how to provide it (prebundled, user-installed, container-image).

**Pro:** uniform with existing bindings grammar.
**Con:** subprocess is a big hammer for what's really a static prereq declaration. Also conflates "can spawn this tool" with "this tool is installed."

### Option C: Stay silent in spec, document per-runtime convention

Each polyfill-runtime author picks its own mechanism. The PDPP CLI prints missing-tool errors with install hints; a Vercel-hosted runtime preinstalls the tools it's willing to support.

**Pro:** no spec change.
**Con:** consent cards can't show requirements; audit tooling can't inspect them; portability between runtimes breaks.

## My read

Option A is the right answer if we care about:
- Supply-chain audit (Linux Foundation review of PDPP would want this)
- License disclosure in grants (AGPL subprocess ≠ MIT subprocess from user's perspective)
- Hosted-deployment planning (which tools does a hosted PDPP need to vendor?)

Option B loses because subprocess-spawning authority is already implicit in the polyfill-runtime binding model — adding a binding kind for each tool is the wrong abstraction.

Option C defers the problem and will be re-raised every time a new connector adds a tool.

## Recommended language for the spec (if Option A lands)

> Manifests MAY declare `runtime_requirements.external_tools` as an array of objects describing subprocess binaries the connector depends on. Each object SHALL include `name`, `license`, and `purpose`; MAY include `min_version`, `install_hint`, and `detect`. Runtimes SHOULD verify declared tools are available before spawning the connector and SHOULD surface missing tools via INTERACTION kind=setup_required. Consent-flow UIs SHOULD display declared tools (especially license) to the owner before grant issuance.

## Cross-references

- `connector-configuration-open-question.md` — both are about manifest-declarable requirements
- `credential-storage-open-question.md` — related: what the connector needs *to run*
- `slackdump-design-gaps.md` — slackdump is the motivating case for this question

## Action items

- [x] Inventory which connectors already rely on external tools (today: slack; future: many)
- [x] If Option A lands, retrofit slack manifest with `external_tools` declarations
- [ ] Consider how this interacts with hosted runtimes (Vercel would preinstall vs. self-hosted checks at spawn)
