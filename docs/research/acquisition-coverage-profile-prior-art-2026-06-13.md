# Acquisition & Coverage Profile Prior Art
**Date:** 2026-06-13  
**Author:** workstream ri-acquisition-profile-prior-art-v1  
**Status:** Final — citable research corpus

---

## Purpose

This document synthesizes prior art for a generalized Collection Profile acquisition/coverage model that covers:
- Google Maps Timeline (manual file export, no API for raw Timeline points)
- WhatsApp chat exports and media sync
- Future irregular exported-data sources (Apple Health, GPX, etc.)

It does not re-litigate all Google Maps or WhatsApp specifics already captured in sibling research files. It draws on those and adds new prior art for the generalized model.

---

## 1. Immich: Mobile Backup vs. External Library — Two Distinct Source Channels

**Source:** https://docs.immich.app/features/libraries/ (accessed 2026-06-13)  
**Source:** https://docs.immich.app/features/mobile-backup/ (accessed 2026-06-13)  
**Source:** https://github.com/immich-app/immich/discussions/15009 (accessed 2026-06-13)  
**Source:** https://alternativeto.net/news/2025/3/immich-1-130-enhanced-photo-and-video-management-with-faster-scans-and-smarter-search (accessed 2026-06-13)

### What Immich does

Immich separates two fundamentally different acquisition channels that look superficially similar (both bring in photos):

| Channel | Identity anchor | Trigger | Dedup unit |
|---|---|---|---|
| **Mobile backup** | App-authenticated device upload | App open / background | File hash + device ID |
| **External library** | Filesystem path on server | Manual scan / scheduled scan | File path on disk |

The two channels are **not interchangeable at the data model level**: you cannot upload a mobile backup into an external library path, and you cannot use an external library scan to deduplicate against mobile-uploaded content automatically. This is a known tension with an open feature request (Discussion #15009).

**Immich 1.130 (March 2025)** rewrote external library scan, achieving 10–100x speed improvement via SQL batching and reduced filesystem calls. Key rewrite decision: scan stores a **path → asset** mapping and re-runs against the current filesystem state, marking missing files as offline rather than deleting them.

### Conclusion

**Two source channels with distinct identity anchors is the correct model, not one unified "photos" concept.** When PDPP models file uploads (manual export drops) vs. device sync (local collector pushes), these are analogous and must preserve separate provenance, not be collapsed into one "file" primitive.

---

## 2. Timelinize: Multi-Source Import with Explicit Data Source Types

**Source:** https://timelinize.com/ (accessed 2026-06-13)  
**Source:** https://timelinize.com/docs/data-sources/google-location-history (accessed 2026-06-13)  
**Source:** https://timelinize.com/docs/data-sources/google-photos (accessed 2026-06-13)  
**Source:** https://pkg.go.dev/github.com/mholt/timeliner (accessed 2026-06-13)

### What Timelinize does

Timelinize is the most relevant prior art for the generalized acquisition model. It defines an explicit `DataSource` type per provider/format, and each data source declares which acquisition method it supports:

| Acquisition method | Timelinize implementation |
|---|---|
| **API pull** | `add-account` command → OAuth flow → background poll |
| **Export file import** | File/archive upload, format auto-detected by the data source type |
| **Rescan / incremental** | ETag/checksum comparison if provider exposes it; otherwise full re-parse |

Key design decisions in Timelinize:
1. **Partial item merging:** Google Photos Takeout splits content from metadata across different archives. Timelinize ingests "partial items" as it encounters each file and merges them by a stable key as it progresses. This is explicit in the code, not an edge case.
2. **Deduplication is source-type-scoped:** Exact-duplicate suppression happens within a data source import. Cross-source deduplication (e.g., same photo imported from both Google Photos and Dropbox) is handled by entity merging with a user confirmation step, not silently.
3. **Differential reprocessing requires an ETag:** Timelinize documents this explicitly — if the data source cannot provide a checksum or ETag, there is no cheap way to detect changes. This is a deliberate gap, not an oversight.
4. **SQLite + local file folder:** Stable, queryable, no schema migration ceremony for users.

### Conclusion

Timelinize's `DataSource` abstraction is the closest prior art to what PDPP's Collection Profile needs: a named, versioned source type that declares its acquisition method, identity anchor for dedup, and provenance facts. The "partial item merge by stable key" pattern is directly applicable to WhatsApp exports (messages and media arrive separately, must be correlated by message ID).

---

## 3. Dawarich: Import Pipeline with Format Auto-Detection and Coordinate+Timestamp Dedup

**Source:** https://dawarich.app/docs/features/imports/ (accessed 2026-06-13)  
**Source:** https://dawarich.app/import-export/ (accessed 2026-06-13)  
**Source:** https://github.com/Freika/dawarich/discussions/2468 (accessed 2026-06-13)  
**Source:** https://dawarich.app/tools/timeline-merger/ (accessed 2026-06-13)

### What Dawarich does

Dawarich's import model is simpler than Timelinize's but has clear decisions that are useful:

1. **Async pipeline:** File upload → format detection → background job → Point records. Users are not blocked waiting for large imports.
2. **Dedup unit:** `(user_id, latitude, longitude, timestamp)` uniqueness constraint at the DB level. Importing the same file twice is safe — no duplicates created.
3. **Cross-source overlap is a known unsolved problem:** When a user records the same route from a Garmin device AND the Dawarich iOS app simultaneously, the two imports create overlapping but non-identical points. Dawarich offers a browser-side Timeline Merger tool for pre-import deduplication, but no server-side cross-source dedup. The discussion thread #2468 explicitly frames this as a hard problem without a clean solution.
4. **Watched directory:** `tmp/imports/watched` is polled every 60 minutes. Files dropped there are automatically ingested. This is device-sync-adjacent behavior without requiring a push protocol.
5. **Source format preserved in import record:** Each import retains the source format (`google_records`, `gpx`, `owntracks`, etc.) as a provenance fact on the import, not just on individual points.

### Conclusion

Dawarich's model confirms: **dedup unit must be defined per acquisition method, not globally.** A coordinate+timestamp pair is the right unit for GPS tracks. A message ID is the right unit for chat messages. A file hash is the right unit for media blobs. A single universal dedup key is wrong. Also: **preserving import-level provenance** (which source type, which file, when ingested) is non-negotiable for debuggability.

---

## 4. Google Takeout / Google Photos: Incremental Export and the Duplicate Photo Problem

**Source:** https://www.ghacks.net/2026/06/02/google-photos-adds-incremental-exports-to-takeout-to-avoid-re-downloading-entire-libraries/ (accessed 2026-06-13)  
**Source:** https://github.com/immich-app/immich/issues/24917 (accessed 2026-06-13)  
**Source:** https://metadatafixer.com/learn/google-takeout-duplicate-photos-explained (accessed 2026-06-13)

### Key findings

**Incremental Takeout for Photos** launched in June 2026: after an initial full export, scheduled exports only include photos added/edited since the last export. Users must select Google Photos as the only product to use this feature. Cadence: every two months for one year.

**The duplicate photo problem is structural:** Google Takeout creates duplicate copies of photos for each album they appear in (one in the root, one per album). This is not a bug — it is how Takeout is designed. Any importer must deduplicate by photo content hash or stable ID, not by filename or path.

**EXIF date correction does not fix Immich's import date grouping:** Even when EXIF dates are corrected before import, Immich groups assets by import execution date rather than EXIF date in some code paths (Issue #24917, open as of 2026-06). This is a known failure mode for incremental Takeout imports: users see thousands of photos grouped under "today" even though the photos are old.

### Conclusion

For PDPP, these findings drive two requirements:
1. **The ingestion timestamp must never be used as the record's event timestamp.** The record's canonical time is what was in the source file, not when PDPP processed it.
2. **Export-file dedup must be content-hash or stable-ID based**, not filename or path based. Filenames from Takeout exports are not stable across successive exports.

---

## 5. Apple Health Export: All-or-Nothing Export, No Date Filtering

**Source:** https://www.igeeksblog.com/how-to-import-and-export-health-app-data-on-iphone/ (accessed 2026-06-13)  
**Source:** https://apps.apple.com/us/app/health-data-importer/id1158733998 (accessed 2026-06-13)  
**Source:** https://rungap.zendesk.com/hc/en-us/articles/222528287-Using-Apple-Health-with-RunGap (accessed 2026-06-13)

### Key findings

- Apple Health's built-in export is **all-or-nothing**: full XML export, no date range selection, no metric selection. For a user with years of health data, this is a large file.
- **Re-importing after a gap:** The common user problem is switching platforms (e.g., Garmin → Apple Watch) and discovering a year gap. Third-party tools (RunGap, Health CSV Importer) fill this by importing historical workouts from the old platform. These imports are accepted but **do not retroactively close activity rings or affect trend comparisons** — Apple Health treats them as second-class historical records.
- **Third-party importers handle partial coverage** by accepting CSV/XML subsets and merging them by data type + timestamp. Health CSV Importer is "battle-tested with millions of data points and hundreds of CSV formats."

### Conclusion

Apple Health's model shows what happens when you have **no incremental export at the source**: importers must accept repeated full exports and deduplicate on their side. The right PDPP response is: **accept repeated uploads of the same export file gracefully** (idempotent ingest), report what is new vs. already-known, never error on re-upload. This is the same requirement as Dawarich's "same file twice is safe."

---

## 6. WhatsApp Export: Media-Message Separation and Size Limits

**Source:** https://waexport.wadesk.io/blog/whatsapp-chat-history-export (accessed 2026-06-13)  
**Source:** https://tech.news.am/eng/news/6595/how-to-export-chats-and-media-from-whatsapp-without-losing-anything.html (accessed 2026-06-13)  
**Source:** https://fone.tips/export-whatsapp-chat/ (accessed 2026-06-13)  
**(Detailed WhatsApp prior art already in docs/research/whatsapp-connector-prior-art-2026-06-12.md)**

### Key findings relevant to generalized model (not re-litigated in detail)

- WhatsApp's native export separates messages (`.txt`) from media (files in the same ZIP). The two must be correlated by message ID embedded in the text body.
- **Message caps:** 10,000 messages with media, 40,000 without. Large chats require multiple exports to cover the same conversation window — these are partial, potentially overlapping.
- **Media is missing by default** in many export workflows (email attachment size limits, storage constraints). The importer must handle message records with no attached media gracefully — not as errors, but as declared coverage gaps.
- **Re-import of the same export is the normal case** for users building a complete archive from multiple partial exports (different time windows, different chats).

### Conclusion

WhatsApp exports confirm: **partial coverage and missing media are expected inputs, not error states.** The model must distinguish "media declared but not uploaded" from "media truly absent" from "media not applicable." This is a first-class coverage fact, not a side-effect.

---

## 7. Import UX Patterns: The Five-Stage Framework and Bulk Import Best Practices

**Source:** https://www.importcsv.com/blog/data-import-ux (accessed 2026-06-13)  
**Source:** https://smart-interface-design-patterns.com/articles/bulk-ux/ (accessed 2026-06-13)  
**Source:** https://blog.csvbox.io/file-upload-patterns/ (accessed 2026-06-13)

### Five-stage framework (adapted for personal data import)

| Stage | What good looks like | Common failure mode |
|---|---|---|
| **Pre-upload** | Show expected format, size limit, what will be extracted | No guidance → user uploads wrong file |
| **Upload** | Progress indicator, cancel option, large file support | Timeout with no feedback |
| **Parse/Map** | Show preview of what was parsed, flag unknowns | Silent parse failure |
| **Validate** | Surface duplicates, coverage gaps, missing media | All-or-nothing reject |
| **Confirm** | Summary: N new records, M already known, K media missing | Commit with no receipt |

The most cited failure mode: **focusing only on stages 2 and 5** (upload button + success toast) and neglecting parse feedback, duplicate surfacing, and coverage summary before commit.

### Key UX patterns observed in SLVP-adjacent products

- **Stripe's CSV invoice import:** Shows column mapping, duplicate detection, and a "preview N rows will be imported" screen before committing. Never silently discards records.
- **Linear's CSV import:** Pre-upload template download, post-parse validation with inline error rows, import receipt with counts.
- **Plaid's Link flow (multi-institution):** Each connection is clearly labeled with its source institution, last-updated timestamp, and health status. Adding a second connection from the same bank creates a new distinct entry — no silent merge.

### Conclusion for PDPP

**The confirmation/receipt step is the UX moment for coverage reporting.** Users need to see: "73 new conversations imported, 12 conversations already known (skipped), 8 conversations imported without media (media not included in this export)." This is the empathy point — it explains why the upload felt incomplete without being a failure state.

---

## 8. Synthesis: Minimum Acquisition Method Vocabulary

Across all prior art, four distinct acquisition methods appear repeatedly with different identity semantics:

| Acquisition method | Identity anchor | Trigger | Examples |
|---|---|---|---|
| **provider_api** | Provider-issued resource ID (stable, opaque) | Scheduled poll / webhook | Gmail, GitHub, Slack |
| **owner_export_upload** | Content hash OR stable record ID embedded in export format | Owner uploads file(s) | Google Maps Timeline, Apple Health, WhatsApp .txt+media |
| **device_sync** | Device ID + local path or record UUID | Local collector push | Immich external library, local collector |
| **assisted_manual** | Same as owner_export_upload but human step required to initiate each export | Owner-triggered after human action | Scheduled Google Takeout, ChatGPT conversation export |

The key insight: **`assisted_manual` is not a fifth method — it is `owner_export_upload` with a `requires_human_trigger: true` flag.** The acquisition mechanics (file parsing, dedup, coverage) are identical. The difference is what triggers the upload.

This maps directly to the interaction postures already in the PDPP reference implementation (`none`, `credentials`, `otp_likely`, `manual_action_likely`). The acquisition method vocabulary should be orthogonal to interaction posture, not collapsed into it.

---

## 9. Essential Coverage/Provenance Facts for Irregular Uploads

From the prior art, the essential provenance facts for an `owner_export_upload` acquisition are:

| Fact | Why essential | Source |
|---|---|---|
| `source_format` | Parse logic is version-specific; format changes break old parsers | Timelinize, Dawarich |
| `source_format_version` | Google Location History changed format multiple times | Timelinize Google Location History docs |
| `upload_id` (stable, idempotent) | Re-upload of same file must be detectable | All prior art |
| `content_hash` | File-level dedup, not filename-based | Google Takeout duplicate problem |
| `record_count_in_source` | Coverage completeness: did we parse everything we expected? | Timelinize, Apple Health importers |
| `record_count_ingested` | Δ = what is new vs. already known | Dawarich import receipt |
| `media_declared_count` | How many media references appear in the export | WhatsApp prior art |
| `media_attached_count` | How many media files were actually provided | WhatsApp prior art |
| `time_range_covered` | Earliest and latest event timestamp in this upload | Google Takeout incremental |
| `parsed_at` | When PDPP processed the file (never used as event time) | Google Takeout EXIF problem |
| `parser_version` | Enables reprocessing when parser is upgraded | Timelinize differential reprocessing |

**Non-essential at Collection Profile level** (implementation detail):
- Intermediate parse states
- Per-record error codes (too granular for profile; surface as aggregate counts)
- Media file paths on disk

---

## 10. Cross-Method Source Identity

The hardest problem in the prior art: when the same underlying data arrives via two different acquisition methods, should PDPP merge them?

Prior art answers:

- **Timelinize:** Cross-source entity merging is a user-confirmed step, not automatic. The system flags probable matches ("same photo seen in Google Photos import and Dropbox import") but does not merge without user action.
- **Dawarich:** No cross-source merge at all — the coordinate+timestamp uniqueness constraint prevents exact duplicates, but near-duplicates from overlapping GPS devices coexist.
- **Immich:** Mobile backup vs. external library do not deduplicate against each other by design.
- **Apple Health:** Multiple sources writing the same data type are surfaced via source priority settings, not merged transparently.

**Conclusion:** Cross-method deduplication is a hard problem with no clean prior art. The right initial answer is: **do not attempt automatic cross-method merge.** Surface coverage overlaps as an informational fact ("this time range was also covered by a prior Google Takeout upload") but preserve both ingestion events. Let the owner decide.

---

## 11. UX Pattern for Non-OAuth Sources: Empathy Without Fake Affordances

From the Google Maps Timeline UX research (sibling doc) and WhatsApp prior art:

**Anti-patterns observed:**
- Showing an OAuth connect button that is actually a file upload in disguise
- "Syncing" language when the source requires manual re-export each time
- No guidance on how to obtain the export file
- Error state for a "complete" import that has missing media (this is expected, not an error)

**Patterns that work:**
- Guided wizard with platform-specific export instructions inline
- "Don't have your data yet? Here's how to get it." helper text before the drop zone
- Post-import coverage summary before calling anything "done"
- Honest staleness: "Data covers up to [date]. Re-export from [source] to refresh."
- For missing media: "8 conversations imported without media. Export with media included to add them later."

**SLVP-adjacent example:** Plaid's institution connection shows the source name, last-refresh timestamp, and a "Update connection" CTA when credentials are stale — not an error, not hidden. This is the right template for PDPP's non-OAuth connections: always show what you have, when it is from, and what the owner needs to do to refresh it.

---

## References (all URLs)

- https://docs.immich.app/features/libraries/
- https://docs.immich.app/features/mobile-backup/
- https://github.com/immich-app/immich/discussions/15009
- https://github.com/immich-app/immich/discussions/19853
- https://alternativeto.net/news/2025/3/immich-1-130-enhanced-photo-and-video-management-with-faster-scans-and-smarter-search
- https://timelinize.com/
- https://timelinize.com/docs/data-sources/google-location-history
- https://timelinize.com/docs/data-sources/google-photos
- https://pkg.go.dev/github.com/mholt/timeliner
- https://dawarich.app/docs/features/imports/
- https://dawarich.app/import-export/
- https://github.com/Freika/dawarich/discussions/2468
- https://dawarich.app/tools/timeline-merger/
- https://www.ghacks.net/2026/06/02/google-photos-adds-incremental-exports-to-takeout-to-avoid-re-downloading-entire-libraries/
- https://github.com/immich-app/immich/issues/24917
- https://metadatafixer.com/learn/google-takeout-duplicate-photos-explained
- https://www.igeeksblog.com/how-to-import-and-export-health-app-data-on-iphone/
- https://apps.apple.com/us/app/health-data-importer/id1158733998
- https://rungap.zendesk.com/hc/en-us/articles/222528287-Using-Apple-Health-with-RunGap
- https://waexport.wadesk.io/blog/whatsapp-chat-history-export
- https://tech.news.am/eng/news/6595/how-to-export-chats-and-media-from-whatsapp-without-losing-anything.html
- https://fone.tips/export-whatsapp-chat/
- https://www.importcsv.com/blog/data-import-ux
- https://smart-interface-design-patterns.com/articles/bulk-ux/
- https://blog.csvbox.io/file-upload-patterns/
