# Congestion-Control Theory as the Lens for a Fastest-Safe Adaptive Rate Governor

**Research date:** 2026-06-10  
**Scope:** TCP congestion-control canon → principles that transfer to a single-provider HTTP scraper; window vs. rate verdict; broken TCP assumptions.

---

## Sources

- Chiu & Jain (1989): *Analysis of the Increase/Decrease Algorithms for Congestion Avoidance in Computer Networks.* Computer Networks and ISDN, 17(1). (foundational AIMD proof)
- Jacobson (1988): *Congestion Avoidance and Control.* SIGCOMM '88. https://ee.lbl.gov/papers/congavoid.pdf
- Brakmo, O'Malley & Peterson (1994): *TCP Vegas: New Techniques for Congestion Detection and Avoidance.* SIGCOMM '94. https://pages.cs.wisc.edu/~akella/CS740/F08/740-Papers/BOP94.pdf
- Cardwell et al. / Google (2016): *BBR: Congestion-Based Congestion Control.* ACM Queue, Sept/Oct 2016. https://queue.acm.org/detail.cfm?id=3022184
- Peterson & Davie: *TCP Congestion Control: A Systems Approach.* https://tcpcc.systemsapproach.org/algorithm.html and /avoidance.html
- Netflix (2018): *Performance Under Load — Adaptive Concurrency Limits.* https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581 ; library https://github.com/Netflix/concurrency-limits
- AWS (2020+): *Retry behavior — AWS SDKs and Tools.* https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html
- Farkiani, Liu & Crowley (2025): *Rethinking HTTP API Rate Limiting: A Client-Side Approach.* arXiv:2510.04516v3. https://arxiv.org/html/2510.04516v3

---

## Part 1 — The Theory in 8–10 Crisp Points

### 1. AIMD is the unique dynamics that converge to both fairness and efficiency simultaneously

Chiu & Jain (1989) proved geometrically that any increase/decrease policy reaches the fairness+efficiency equilibrium only if the increase is additive and the decrease is multiplicative. Additive increase (AI) alone is efficient but unfair among competing flows. Multiplicative decrease (MD) alone is fair but leaves capacity underused. Only the combination produces a trajectory that spirals into the fair, full-capacity operating point in the state space of all senders' window sizes. The convergence is independent of the number of senders and of their initial states — it is an asymptotic attractor, not a tuned set-point.

For a single-sender HTTP client with no competing flows, the fairness half of the argument is trivially satisfied. The efficiency half still applies: AIMD is the correct update law for any rate governor that must probe an unknown ceiling from below without overshooting destructively. The probe-then-back-off sawtooth is not a flaw; it is the mechanism by which the governor continuously re-estimates a ceiling it cannot observe directly.

### 2. Loss-based control (Reno/CUBIC) requires the client to overfill the pipe to discover the ceiling — the correct analogue for HTTP is 429, and that is too expensive

In TCP Reno, congestion is inferred from packet loss. Loss is "cheap" in TCP because a retransmitted packet costs only a few hundred microseconds. The algorithm must touch the ceiling (cause loss) on every AIMD cycle to update its estimate of BtlBw. This is design-correct for TCP because the cost of a loss event is low.

For a consumer-account HTTP scraper, the "loss" signal is a 429 (or worse, a silent throttle or a ban). The cost of the equivalent event is orders of magnitude higher: account suspension risk, session invalidation, operator intervention. A rate governor that relies on actually triggering 429s to update its ceiling estimate is using loss-based control on a channel where loss is expensive. This is the first broken assumption.

### 3. Delay-based control (Vegas, BBR) probes the ceiling without causing loss — it is the correct model for consumer-account HTTP

TCP Vegas (Brakmo et al., 1994) was the first algorithm to use rising RTT as an early congestion signal. Vegas compares the measured throughput against the expected throughput at the current window size and base RTT. When measured throughput falls below expected, it infers queue build-up and backs off *before* a packet is dropped. The linear decrease on early signal (not the multiplicative decrease on actual loss) is deliberate: it trades a modest throughput reduction for the avoidance of the loss event itself.

BBR (Google, 2016) makes the same argument more rigorously. BBR's central claim (from the ACM Queue paper): "A connection runs with the highest throughput and lowest delay when (rate balance) the bottleneck packet arrival rate equals BtlBw and (full pipe) the total data in flight equals BDP." BBR achieves this by estimating BtlBw and RTprop continuously and setting its send rate to match them, rather than probing by overflow. The analogy for HTTP: if a provider starts adding latency before issuing 429s (common — servers slow down first), a latency-aware governor can back off before the hard signal arrives.

### 4. TCP controls a window (in-flight count) because the channel is self-clocking via ACKs — a window is the correct control variable when round-trip time determines effective throughput

TCP's congestion window is not a rate; it is a maximum concurrent-in-flight byte count. Rate emerges from the combination of window size and RTT via Little's Law: rate = window / RTT. The reason TCP uses a window rather than specifying a rate directly is ACK self-clocking: as ACKs return, they release space in the window and implicitly pace the sender at the bottleneck's delivery rate. No explicit timer is needed; the feedback loop is the channel itself.

Little's Law (L = λW) makes the relationship precise: if L is the in-flight count (concurrency), λ is the throughput rate, and W is round-trip latency, then for fixed L, rate falls as latency rises. A window-based controller therefore automatically compensates for latency changes: if the server slows down, in-flight requests fill the window sooner, the effective send rate drops, and the governor sees the latency signal without additional instrumentation.

### 5. BBR explicitly unifies window and rate into two coupled control variables — and names pacing_rate as primary

BBR's ACM Queue paper is explicit: "pacing_rate is BBR's primary control parameter. A secondary parameter, cwnd_gain, bounds inflight to a small multiple of the BDP to handle network and receiver pathologies." BBR computes `nextSendTime = now + packet.size / (pacing_gain × BtlBwFilter.currentMax)` — an explicit rate — and uses the window only as a safety bound on inflight bytes. The two are not independent: pacing_rate = pacing_gain × BtlBw and cwnd = cwnd_gain × BDP = cwnd_gain × BtlBw × RTprop. Both derive from the same two estimated quantities.

The key insight: when RTT is short and stable (as it is for a single provider on a good connection), window and rate carry the same information. The choice between them is an implementation question, not a theoretical one. Window-based control is appropriate when RTT varies significantly (window self-compensates). Rate-based control is appropriate when RTT is stable and you want explicit inter-request spacing. For a scraper making serial or low-concurrency requests to one provider, either formulation works, and they are equivalent by Little's Law.

### 6. The single-sender case eliminates the fairness dimension entirely — the control problem simplifies

TCP's convergence proof assumes multiple competing flows that share a bottleneck. For a single HTTP client scraping one provider, there are no other senders competing for the same quota. The fairness dimension of AIMD is irrelevant. What remains is purely an efficiency-and-safety problem: find the maximum sustainable rate, approach it from below, and retreat immediately on any signal that it has been exceeded. The single-sender simplification also means there is no need for random jitter in the AIMD increase — jitter exists to desynchronize competing flows, not to improve single-flow behavior. (Jitter in retries is still valuable to avoid periodic patterns that may look like abuse to the provider, but that is a different concern.)

### 7. Slow-start / binary-search startup is theoretically correct but practically dangerous for consumer-account clients

TCP slow-start doubles the window each RTT until loss is detected, discovering BtlBw in log2(BDP) RTTs at the cost of up to 2×BDP of queue (and eventually one loss event). BBR implements the same binary-search startup for the same reason. For a new HTTP session against a provider with unknown rate limits, starting conservatively and increasing linearly (AI only, no slow-start) is slower to reach the ceiling but eliminates the risk of triggering a ban during the discovery phase. This is the second broken assumption: TCP assumes the startup overshoot is recoverable at low cost. For a consumer account, the startup probe needs to be gentler.

### 8. Retry/backoff is structurally separate from the rate governor — conflating them creates double-payment

In TCP, retransmission (the retry layer) and congestion control (the rate governor) are separate mechanisms. Retransmission handles individual segment loss; congestion control adjusts the flow-level send rate. The two interact only through the congestion signal: a loss event triggers both a retransmit and a multiplicative decrease. They do not share a time budget or a delay pool.

In an HTTP client, the equivalent separation is: retry-with-backoff handles individual request failures (reconnect, transient error, Retry-After header); the rate governor adjusts the inter-request pace or concurrency across all requests. If a retry loop already sleeps for the Retry-After interval before re-attempting, and then the rate governor *also* applies a cooldown for the same event, the backoff is paid twice. The governor must distinguish absorbed pressure (the request already paid the wait) from unabsorbed pressure (the next request still owes the wait). PDPP's `absorbedByRequestWait` flag in `AdaptiveLanePressure` is exactly the correct implementation of this structural separation.

### 9. A hard ceiling is required when the downstream consequence of overrun is ban-risk, not just retransmission

TCP has no hard ceiling concept because the cost of overrunning is bounded (a retransmit, a window halving). A consumer-account scraper operates in a regime where repeated overrun triggers account-level consequences with no automatic recovery. Theory offers no direct analogue; this is a domain constraint that must be layered on top of the AIMD governor as a hard cap that the additive increase is not allowed to exceed. The cap is not part of the convergence dynamics; it is a safety boundary that prevents the AIMD probe from exploring the upper tail of the rate distribution at all. This is the third broken TCP assumption.

### 10. Latency increase is a better congestion signal than 429 for the same reason Vegas beats Reno — it arrives earlier and does not consume quota

Vegas uses rising RTT to back off before the loss event. For an HTTP scraper, the equivalent is: if the provider starts returning responses more slowly than baseline, it is likely building a queue or applying soft throttling. This signal arrives before the 429, costs nothing (no consumed quota, no ban risk), and allows the governor to back off gracefully. 429 is still a necessary signal for the multiplicative decrease (it is an unambiguous "you are over the ceiling" message), but it should not be the *only* signal. A governor that also watches median response latency against a rolling minimum baseline will respond earlier and cause fewer hard throttle events — the direct HTTP analogue of switching from Reno to Vegas.

---

## Part 2 — Window vs. Rate: The Verdict from Theory

**The correct answer is: rate (inter-request interval) for a low-concurrency scraper; concurrency window for a high-parallelism request pipeline. For PDPP's ChatGPT connector, rate is sufficient and simpler.**

The theoretical argument:

Little's Law makes window and rate equivalent when latency is stable: `window = rate × latency`. For TCP, latency is the round-trip propagation time of the network path, which is highly variable, making window-based control superior (the window self-adjusts as RTT varies without needing to recalculate rate explicitly). For an HTTP client making requests to a single endpoint, round-trip latency is dominated by server processing time, which is roughly constant at baseline. In this regime, window and rate carry the same information, and rate-based control (controlling the inter-request interval directly) is simpler to implement, reason about, and observe.

Where concurrency becomes the *necessary* variable is when requests are genuinely parallel and the bottleneck is in-flight concurrency rather than arrival rate. Netflix's `concurrency-limits` library (2018) was designed for RPC services where many goroutines fire simultaneously and the bottleneck is server-side thread pool exhaustion. The congestion signal there is latency increase under high concurrency (Gradient2/Vegas algorithms). For this case, controlling a window (max in-flight) is correct because it directly bounds the resource the server is protecting.

For a sequential or low-concurrency HTTP scraper (as ChatGPT's connector is), where each conversation is fetched one or a few at a time, the effective concurrency is already small. The bottleneck is not in-flight parallelism but arrival rate over time. Rate control (interval between sends) is the appropriate single variable.

**The fork resolves to rate.** One adaptive token bucket or GCRA controller with a rate-based AIMD fill-rate — additive increase on success, multiplicative decrease on 429 or rising latency — is the correct minimal architecture. A concurrency window adds genuine value only if the connector moves to high-parallelism bulk fetching, at which point Netflix's concurrency-limits approach (VegasLimit or Gradient2) is the right template.

The AWS SDK adaptive mode confirms this for the single-provider case: its rate limiter controls `fill_rate` (a token generation rate) with AIMD dynamics triggered by throttling responses. The SDK documentation explicitly notes: "the adaptive retry strategy assumes the client works against a single resource." AWS chose rate, not concurrency, for the single-resource case.

The 2025 academic paper (Farkiani et al., arXiv:2510.04516v3) independently reaches the same conclusion. Their ATB algorithm ("Adaptive Token Bucket") controls the token generation rate with AIMD dynamics on 429 signals and reduces 429 errors by 70–97% over exponential backoff. Their control variable is rate (tokens per second), not concurrency. Concurrency is not mentioned as a control variable in their formulation.

---

## Part 3 — TCP Assumptions That Break for a Consumer-Account HTTP Client

| TCP Assumption | How It Breaks |
|---|---|
| **Loss is cheap** (a retransmit costs microseconds) | Loss equivalent (429 or ban) triggers quota consumption, session risk, or account suspension. The governor must not rely on touching the ceiling to estimate it. |
| **Startup overshoot is recoverable** (slow-start doubles until loss, log2 convergence) | Binary-search startup against a rate-limited provider risks triggering a hard block during the discovery phase. Linear increase from a conservative start is correct even though it is slower. |
| **No hard ceiling exists** (BtlBw is a physical property, not a policy) | The provider's rate limit is a policy ceiling. AIMD must be capped so the additive probe never explores above a safe maximum, regardless of observed success. |
| **Multiple competing flows** (fairness is a required property) | Single sender, no competing flows. Fairness dimension is irrelevant; jitter for desynchronization is unnecessary (though retry jitter for pattern-avoidance is still useful). |
| **The bottleneck is observable via RTT** (ACK timestamps give RTT) | The server's rate limit is opaque. RTT increase is still a useful leading signal (vendor server slowdown precedes 429) but is not a precise bottleneck model. 429 is the hard signal; latency is the soft signal. |
| **Self-clocking via ACKs** (ACKs naturally pace the sender) | HTTP responses do not clock subsequent requests. The client must implement explicit pacing. A GCRA/token-bucket correctly replaces ACK self-clocking in this setting. |
| **Cheap retry quota** (standard mode allows dozens of retries) | Retries consume quota. A retry-after-429 should be expensive in the internal token budget, not cheap. The retry layer and rate governor must be structurally separated to avoid double-paying backoff. |

---

## Summary Verdict for PDPP's Candidate SLVP

The theoretical framing is confirmed with one refinement:

**Confirmed:** One adaptive controller, one control variable (rate / token fill rate), AIMD dynamics (additive increase on success, multiplicative decrease on 429), hard safety ceiling. This is theoretically grounded and matches all three production references (AWS adaptive mode, Netflix concurrency-limits, Farkiani et al. 2025).

**Confirmed:** The three essential surrounding components are exactly (1) a congestion signal — 429 as the hard signal, rising latency as the soft/early signal; (2) a retry/backoff layer kept structurally separate from the rate governor; (3) a hard safety ceiling because loss is not cheap.

**Refined:** The "window vs. rate" fork resolves to **rate** for PDPP's ChatGPT connector's current sequential/low-concurrency request pattern. Concurrency window control is theoretically equivalent (via Little's Law) but is the appropriate abstraction only for a high-parallelism pipeline where the bottleneck is in-flight concurrency. Controlling both independently introduces genuine two-dimensionality only when the two are not coupled by a stable latency — i.e., when latency varies widely and independently of rate. For a single provider with stable response times, rate and window carry the same information and a single rate controller is sufficient.

**The PDPP incidental complexity diagnosis is confirmed by theory:** Dual pacing+lane pre-flight waits are two controllers on the same variable. A fixed launch-jitter floor is a hand-tuned constant that overrides the AIMD probe from below (it caps throughput before the governor can find the real ceiling). A self-terminating recovery exit is a mechanism that belongs in the retry layer, not in the rate governor. None of these appear in the canonical TCP, BBR, Netflix, or AWS implementations of the same pattern.
