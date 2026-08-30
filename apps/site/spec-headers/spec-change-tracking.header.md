---
title: "Change Tracking"
description: "Design rationale for grant-relative incremental sync via changes_since cursors, not canonical changelog streams."
---

<Callout type="info" title="Where the normative mechanics live">
  This document is design rationale and decision history. The normative mechanics live in [spec-core](spec-core): Section 4 defines stream semantics, the snapshot model, and tombstones; Section 8 defines the `changes_since` query surface.
</Callout>
