---
title: "Web Spec Publishing Notes"
description: "Maintenance notes for publishing canonical PDPP specs into the web docs."
---

# Web Spec Publishing Notes

Root `spec-*.md` files are canonical for every spec that has both a root copy
and a web docs copy. Web copies keep their Fumadocs frontmatter, then surface
the root spec's `Status:` and `Date:` in a leading callout:

```md
---
title: "Protocol"
description: "..."
---

<Callout type="info" title="Spec status">
  Status: **Draft**

  Date: 2026-04-06
</Callout>

## 1. Introduction
```

Use `type="warn"` when the status is superseded or otherwise cautionary. Do not
edit the web copy's body independently from the root spec; run `pnpm spec:check`
before committing spec-doc changes.

The only web-only spec pages currently allowed are:

- `spec-lexical-retrieval-extension.md`
- `spec-semantic-retrieval-extension.md`

Any additional web-only spec needs an OpenSpec change before the file is added.
