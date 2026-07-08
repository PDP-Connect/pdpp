import type { StreamViewport } from "../../client/geometry.ts";
import type { ProtocolParseResult } from "../../protocol/stream-viewer.ts";
export interface AttachedMessage {
    browser_session_id: string;
    interaction_id: string;
    run_id: string;
    viewport: (StreamViewport & {
        screenHeight?: number;
        screenWidth?: number;
    }) | null;
}
export declare function parseAttachedMessage(data: string): ProtocolParseResult<AttachedMessage>;
//# sourceMappingURL=stream-viewer-protocol.d.ts.map