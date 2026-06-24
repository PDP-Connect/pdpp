# Explore — complete verbatim feedback corpus (Tim) — 2026-06-22

THE canonical source of truth for Tim's Explore feedback + intent, recovered verbatim from the session transcript (31191f1e). Previously this lived only in conversation/summaries and was never written to disk — a violation of the "research/feedback → corpus on disk" HARD RULE, and the reason notes got dropped. Every fix must trace to a line here. Status column reflects deployed state at `dcfeb028` (2026-06-22).

## Standing intent (never changed)
- Build owner-console **Explore** to the SLVP-ideal (Stripe/Linear/Vercel/Plaid) bar, no compromise.
- **count==reachability is sacred**: making 188→32 to be "honest" DESTROYS information (the cop-out); making 188 *reachable* keeps the count AND delivers it. "do you understand the difference?" — yes.
- Working mode: Claude designs + researches prior art, Codex bookends plan + end-review, Tim out of loop until deployed.
- "research prior art, don't skip the reasoning step"; findings MUST land in the corpus on disk.

## Verbatim feedback items + status

### Original consolidated dump (the "15+", line 51 of raw)
> "submitting a search only works with a button press, not pressing enter. the loading animation, on Mobile, is above the fold if you scroll down. 'inspect read request' should be removable given copy view link. there should not be multiple search inputs. users shouldn't have to learn operators like has:image (might be fine if they do for efficient power use). also the operators popup runs off the screen. explore page is missing motion it should have. what should the numbers mean in filters, and what do they mean? rhetorical, don't answer. no way to invert source or stream selections. confused about relation between filters and search operators. I don't think rows should show view full stream link. is open button different than clicking row if not it's useless. how does ui know to show 'message body' for message_bodies? we need to support arbitrary connectors."

| # | Item (verbatim intent) | Status @ dcfeb028 |
|---|---|---|
| 1 | Enter doesn't submit search | ✅ FIXED |
| 2 | **"loading animation, on Mobile, is above the fold if you scroll down"** | ❌ **STILL BROKEN — reproduced live.** `rr-x-progress` pinned to top of `rr-x-main` y:0; scroll container is `.rr-content`; scrolled feed → loader off-screen above. |
| 3 | "inspect read request" removable | ✅ FIXED (removed) |
| 4 | No multiple search inputs | ✅ FIXED (one input) |
| 5 | Operators (has:image) shouldn't be required to learn | ⚠️ PARTIAL — still present; "fine for power use" but never made discoverable/optional clearly |
| 6 | Operators popup runs off screen | ✅ FIXED (in-flow `<details>`) |
| 7 | "explore page is missing motion it should have" | ⚠️ ASSERTED present (rr-x-reveal + reduced-motion CSS) — **never watched in motion**; feed still feels static |
| 8 | **"what should the numbers mean in filters?"** | ❌ NOT ADDRESSED — facet "N in view" counts are opaque |
| 9 | Invert source/stream selections | ✅ FIXED (server-side exclude) |
| 10 | **"confused about relation between filters and search operators"** | ❌ NOT ADDRESSED — left-rail facets vs `con:`/`stream:` operators are two parallel systems, unexplained |
| 11 | Rows shouldn't show "view full stream" link | ✅ FIXED (removed) — but see line 43: appeared still-present at one point; re-verify |
| 12 | Open button vs clicking row distinction | ✅ FIXED (distinct) |
| 13 | **"how does ui know to show 'message body' for message_bodies? support arbitrary connectors"** | ⚠️ PARTIAL — manifest x_pdpp_role, only github piloted; arbitrary-connector presentation thin |

### Additional items recovered from across the transcript (NOT in the "15", several DROPPED)
| # | Item (verbatim) | Status |
|---|---|---|
| 14 | (line 47) "the auto grouping/collapse/expand thing doesn't feel good as is... **load more can collapse rows down not up across multiple streams**... follow SLVP ideal based on prior art" | ⚠️ PARTIAL — preview-by-default shipped; the collapse-DIRECTION mechanic + deeper feel not fully designed |
| 15 | (line 49) 188→32 reachability "a straight violation" — make 188 REACHABLE not shrink to 32 | ✅ FIXED (server past/future split + Upcoming pagination) |
| 16 | (line 37) "load more is showing more results but then some above are being hidden" | ✅ FIXED (accumulate + snapshotSeq rewind) |
| 17 | (line 39) "**on mobile I don't see a timestamp on the row**, and **when I click it I can't see more detail**" | ❓ NEEDS RE-VERIFY on mobile (master-detail push exists; timestamp-on-row?) |
| 18 | (line 39) "I filtered by ChatGPT and clicked load more and the one at the bottom was still at the bottom, sorting seems wrong" | ⚠️ likely the burst-order bug (fixed dcfeb028) — re-verify under a filter |
| 19 | (line 43) "**any idea why an old date is shown first?**" + rows still showing "view full stream →" | ✅ date-order FIXED (semantic-time + burst order); stream link removed — but line 43 shows it WAS present, re-verify |
| 20 | (line 59) records not in monotonic order (23m,23m,23m / 19m,19m) | ✅ FIXED (burst newest-first, dcfeb028) |
| 21 | (line 59) restore PDPP logo + Recordroom→brand, instance-configurable | ✅ DONE (dcfeb028) |
| 22 | (line 57) "explore this page as a user... critical and objective... compares to SLVP products" | ⚠️ DONE once; the verdict = doesn't feel SLVP (see below) |

## THE CORE UNADDRESSED GAP (Tim's 2026-06-22 critical pass)
Line 63: *"I bet if you use darshana or playwright to get eyes on it in desktop and mobile and actually interact a lot you will find that it doesn't feel nearly as good as SLVP products."* — CONFIRMED by a live critical pass:
- **Reads as a developer console, not a product**: all-monospace body text, hairline rows, tiny pale type. The single biggest non-SLVP signal (desktop + mobile).
- **Rows are near-zero-signal**: "messages · peregrine Codex · 31 min · message" — no content preview; a row teaches almost nothing at a glance. SLVP rows carry meaning.
- **Flat visual hierarchy**: "Today" / burst headers / rows compete at similar weight; nothing guides the eye.
- **Left rail = two undifferentiated lists** (16 connections + 74 stream tokens), opaque counts (ties to #8/#10).
- **Feed doesn't use reclaimed width**; dead space remains.

## Corpus coverage audit (why new research is warranted)
~25 Explore research docs exist but cover LOGIC (pagination, relevance/search model, cursors, time-sort, reachability, full-visibility spec, record-explorer *patterns*). They do NOT cover the **visual-feel layer**: record-feed row anatomy/density, type hierarchy (sans vs mono / weight), the dev-console-vs-product question, scannable-row content. The relayout (dcfeb028) fixed LAYOUT + bugs, not FEEL. → Targeted NEW research on the visual-language layer is justified (not a redo).

## Process lessons (so this doesn't recur)
- A reconstructed "list of N" misses notes outside the list AND the holistic feel. Always recover the FULL verbatim corpus from the transcript before claiming completeness.
- "Verified the CSS is present" ≠ "watched it and it feels right." Feel items require living in the UI (Playwright interaction + darshana full-page), not code grep.
- Write feedback to disk immediately (this doc closes that gap).
