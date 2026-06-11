## 1. Spec

- [x] 1.1 Add OpenSpec proposal, design, tasks, and `polyfill-runtime` spec delta.
- [x] 1.2 Validate the OpenSpec change with `openspec validate add-google-maps-timeline-import --strict`.

## 2. Connector

- [x] 2.1 Add `google_maps` manifest with file-only runtime requirements and manual refresh posture.
- [x] 2.2 Add parser support for legacy Google Takeout location records and newer Google Maps Timeline export shapes.
- [x] 2.3 Add normalized `timeline_points` and `timeline_segments` schemas with emit-time validation.
- [x] 2.4 Add connector runtime entrypoint with incremental state and bounded progress messages.
- [x] 2.5 Register `google_maps` with orchestrator and manifest registration smoke path.
- [x] 2.6 Correct Google Takeout `accuracy_meters` manifest type to number/null.

## 3. Tests

- [x] 3.1 Add parser unit tests for legacy points, Timeline path points, visits, activities, invalid coordinates, and stable IDs.
- [x] 3.2 Add schema tests for parser-built records and representative validation failures.
- [x] 3.3 Run the focused connector test subset.
- [x] 3.4 Run a connector typecheck or broader package validation if practical.

## 4. Closeout

- [x] 4.1 Update connector inventory docs.
- [x] 4.2 Report remaining proof gap for a live owner-export pilot.
