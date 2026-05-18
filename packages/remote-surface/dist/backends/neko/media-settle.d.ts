import type { StreamViewport } from "../../client/geometry.ts";
export interface NekoInboundVideoStats {
    bytesReceived?: number;
    frameHeight?: number;
    framesDecoded?: number;
    framesDropped?: number;
    framesPerSecond?: number;
    frameWidth?: number;
    freezeCount?: number;
    packetsLost?: number;
    timestampMs?: number;
}
export interface NekoMediaSettleSample {
    inbound?: NekoInboundVideoStats | null;
    media?: StreamViewport | null;
    requested: StreamViewport;
    screen?: StreamViewport | null;
}
export interface NekoMediaSettleState {
    consecutiveReadySamples: number;
    lastFramesDecoded: number | null;
    lastFreezeCount: number | null;
    lastPacketsLost: number | null;
    samples: number;
}
export interface NekoMediaSettleResult {
    reasons: string[];
    state: NekoMediaSettleState;
    status: "degraded" | "settled" | "settling";
}
export declare function createNekoMediaSettleState(): NekoMediaSettleState;
export declare function assessNekoMediaSettle({ maxSettlingSamples, requiredReadySamples, sample, state, }: {
    maxSettlingSamples?: number;
    requiredReadySamples?: number;
    sample: NekoMediaSettleSample;
    state: NekoMediaSettleState;
}): NekoMediaSettleResult;
//# sourceMappingURL=media-settle.d.ts.map