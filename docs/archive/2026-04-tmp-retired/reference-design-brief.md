# PDPP Reference Page: Design Brief

Answers derived from everything we've built, researched, and discussed.

---

## Audience moment

**Emotional state on arrival:** Curious but skeptical. The CEO is evaluating whether this is real. The engineer is evaluating whether it's sound. The product person is evaluating whether it's better than what they have. The Linux Foundation reviewer is evaluating whether it's rigorous. None of them are pre-sold.

**The one thing they need to believe after 10 seconds:** This is serious work by serious people. The craft signals credibility before the content does.

**The one thing they need to believe after 60 seconds:** PDPP gives users real, enforceable control over their personal data — and it works today, not just in theory.

**Existing mental model to work with:** OAuth. Everyone in the target audience knows OAuth. PDPP is "OAuth but the user can see and control exactly what's shared, at the field level, with retention commitments and revocation." The misconception to prevent: "this requires users to run their own servers" (it doesn't — personal servers are one deployment model).

---

## Content

**Minimum viable story (the load-bearing concepts):**
1. Your personal data has structure (streams, fields, schemas)
2. An app requests specific access (not "all or nothing")
3. You see exactly what's being asked and decide
4. The protocol enforces your decision (field projection)
5. You can revoke at any time

That's five steps. Everything else (connectors, collection methods, incremental sync, multi-platform, export) is enriching but not essential for the "I get it" moment.

**The one slide image:** The field projection — 8 fields enter, 4 come out. Consent → enforcement in a single frame.

**The one tweet sentence:** "PDPP lets you decide exactly which fields of your personal data an app can access — and your server enforces it."

---

## Form

**Scroll, not an experience.** The reader controls the pace. This is an Illustrated Protocol — page structure mirrors protocol flow. Reading = understanding the sequence of operations.

**Visual rhythm:** Not uniform. The consent card and field projection are the peaks — they get featured treatment (larger type, gradient wash, more vertical breathing room). The surrounding sections are quieter (wide two-column, standard padding). This creates the "valley → peak → valley → peak" rhythm that makes the peaks land.

**Existing visual language:** The temperature duality (copper = human surfaces, blue = protocol surfaces). The mono type register for protocol data. The `data-surface` attributes. The elevation system (level 0 for flat, level 1 for cards). The brand type scale (pdpp-display through pdpp-caption). The motion tokens (ease-out-expo for entrances).

**What we need to invent:** A way to show "personal data with structure" that isn't tied to a specific deployment model. The convergence visual is a start but it's too infrastructure-focused. We need something that shows the *data* — streams, fields, the shape of personal information — in a way that creates desire.

---

## Feeling

**What it should feel like:** Authoritative and inevitable. Not selling. Not explaining. Demonstrating. "This is how it works. Of course it works this way."

**The closest feeling from another product:** Stripe's API docs. You read them and think "these people have thought of everything." The rigor creates trust. The design quality creates desire. You want to build on this.

**When someone shares the link, they say:** "Look at how this protocol handles consent and data access. The enforcement is real."

---

## What we're NOT doing

**A bad version looks like:** A marketing page that says "your data, your choice" with stock illustrations and no substance (the Solid cautionary tale). Or: a protocol spec with syntax highlighting and no narrative (the IETF default). Or: a three-panel developer dashboard that only makes sense if you already understand the architecture.

**The line between elegance and dishonesty:** We show one deployment model (personal server) as the primary example but acknowledge others exist. We show one access mode (continuous) but the specimens on /design cover all variants. We don't pretend the personal server is the only way, but we don't dilute the narrative by showing everything at once.

**Complexity we refuse to hide:** The attribution split (what the server enforces vs. what the client promises). The field projection (the RS actually strips fields — this isn't just UI). The revocation propagation window (60 seconds, not instant). These are where the protocol's honesty lives.

---

## What this brief tells us about the opening moment

The opening should establish that personal data has structure — it's not an opaque blob locked in platforms. The structure is what makes everything else possible: per-stream consent, per-field projection, incremental sync, revocation.

The opening should NOT establish:
- Where the data lives (deployment model detail)
- How it got there (infrastructure detail)
- What connectors are (implementation detail)

The opening should make the reader think: "I want my data to be this legible." Then the consent card makes them think: "I want this much control." Then the field projection makes them think: "It actually enforces this."

The infrastructure (connectors, collection methods, personal servers) can come later — as the "how it works under the hood" section, not as the setup for the story.
