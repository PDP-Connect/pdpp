const DEFAULT_REQUIRED_READY_SAMPLES = 2;
const DEFAULT_MAX_SETTLING_SAMPLES = 6;
const FREEZE_REGRESSION_THRESHOLD = 2;
const PACKET_LOSS_REGRESSION_THRESHOLD = 10;
const SETTLE_TOLERANCE_PX = 2;
const MAX_COVER_CROP_RATIO = 0.02;
const VERTICAL_CROP_WEIGHT = 2;
export function createNekoMediaSettleState() {
    return {
        consecutiveReadySamples: 0,
        lastFramesDecoded: null,
        lastFreezeCount: null,
        lastPacketsLost: null,
        samples: 0,
    };
}
function coversRequested(candidate, requested) {
    return (!!candidate &&
        candidate.width + SETTLE_TOLERANCE_PX >= requested.width &&
        candidate.height + SETTLE_TOLERANCE_PX >= requested.height);
}
function fitsRequestedCover(candidate, requested) {
    if (!candidate) {
        return false;
    }
    const width = Math.max(1, candidate.width);
    const height = Math.max(1, candidate.height);
    const scale = Math.max(requested.width / width, requested.height / height);
    const displayedWidth = width * scale;
    const displayedHeight = height * scale;
    const horizontalCropArea = Math.max(0, displayedWidth - requested.width) * requested.height;
    const verticalCropArea = Math.max(0, displayedHeight - requested.height) * requested.width;
    const cropArea = horizontalCropArea + verticalCropArea * VERTICAL_CROP_WEIGHT;
    return cropArea / (requested.width * requested.height) <= MAX_COVER_CROP_RATIO;
}
function inboundCoversRequested(inbound, requested) {
    if (!inbound) {
        return false;
    }
    return coversRequested(typeof inbound.frameWidth === "number" && typeof inbound.frameHeight === "number"
        ? { width: inbound.frameWidth, height: inbound.frameHeight }
        : null, requested);
}
function framesAreProgressing(state, inbound) {
    if (!inbound || typeof inbound.framesDecoded !== "number") {
        return typeof inbound?.framesPerSecond === "number" && inbound.framesPerSecond > 0;
    }
    return state.lastFramesDecoded !== null && inbound.framesDecoded > state.lastFramesDecoded;
}
function qualityRegressed(state, inbound) {
    if (!inbound) {
        return false;
    }
    const freezeRegressed = typeof inbound.freezeCount === "number" &&
        state.lastFreezeCount !== null &&
        inbound.freezeCount > state.lastFreezeCount + FREEZE_REGRESSION_THRESHOLD;
    // Packet-loss counters are cumulative and poll-rate dependent. Keep this as
    // a coarse settling guard only: small deltas are diagnostics, not proof that
    // the stream cannot settle.
    const packetLossRegressed = typeof inbound.packetsLost === "number" &&
        state.lastPacketsLost !== null &&
        inbound.packetsLost > state.lastPacketsLost + PACKET_LOSS_REGRESSION_THRESHOLD;
    return freezeRegressed || packetLossRegressed;
}
function nextState(previous, sample, ready) {
    return {
        consecutiveReadySamples: ready ? previous.consecutiveReadySamples + 1 : 0,
        lastFramesDecoded: typeof sample.inbound?.framesDecoded === "number" ? sample.inbound.framesDecoded : previous.lastFramesDecoded,
        lastFreezeCount: typeof sample.inbound?.freezeCount === "number" ? sample.inbound.freezeCount : previous.lastFreezeCount,
        lastPacketsLost: typeof sample.inbound?.packetsLost === "number" ? sample.inbound.packetsLost : previous.lastPacketsLost,
        samples: previous.samples + 1,
    };
}
export function assessNekoMediaSettle({ maxSettlingSamples = DEFAULT_MAX_SETTLING_SAMPLES, requiredReadySamples = DEFAULT_REQUIRED_READY_SAMPLES, sample, state, }) {
    const reasons = [];
    const screenReady = fitsRequestedCover(sample.screen, sample.requested);
    const mediaReady = fitsRequestedCover(sample.media, sample.requested);
    const inboundReady = inboundCoversRequested(sample.inbound, sample.requested);
    const paintedMediaReady = screenReady && mediaReady;
    if (!screenReady) {
        reasons.push("screen_not_covering_requested_viewport");
    }
    if (!mediaReady) {
        reasons.push("media_not_covering_requested_viewport");
    }
    // n.eko's WebRTC stats can lag behind the actual <video> element during
    // rotation. Once the painted media and n.eko screen are compatible, stale or
    // missing inbound dimensions are diagnostics rather than a reason to keep
    // the owner behind the matte.
    if (!(inboundReady || paintedMediaReady)) {
        reasons.push("inbound_frame_not_covering_requested_viewport");
    }
    if (inboundReady && !framesAreProgressing(state, sample.inbound)) {
        reasons.push("frames_not_progressing");
    }
    if (qualityRegressed(state, sample.inbound)) {
        reasons.push("media_quality_regressed");
    }
    const ready = reasons.length === 0;
    const updatedState = nextState(state, sample, ready);
    if (updatedState.consecutiveReadySamples >= requiredReadySamples) {
        return { reasons: [], state: updatedState, status: "settled" };
    }
    if (updatedState.samples >= maxSettlingSamples) {
        return {
            reasons: reasons.length > 0 ? reasons : ["insufficient_consecutive_ready_samples"],
            state: updatedState,
            status: "degraded",
        };
    }
    return { reasons, state: updatedState, status: "settling" };
}
//# sourceMappingURL=media-settle.js.map