import type { ViewportPayload } from "../../client/geometry.ts";
export interface NekoApplyViewportContext {
    surfaceId?: string;
}
export type NekoApplyViewport = (viewport: ViewportPayload, context?: NekoApplyViewportContext) => Promise<void>;
export declare function createUnimplementedNekoApplyViewport(): NekoApplyViewport;
/**
 * Runtime integration TODO:
 * - snap the shared controller target to an aligned X11/modeline size;
 * - apply the browser window dimensions through the host-owned browser-control
 *   seam, including Browser.setWindowBounds when that mode is allowed;
 * - report residual gutter/crop using the same screen/media/inbound concepts
 *   that `media-settle.ts` already checks for cover-crop regressions.
 *
 * The shared viewport-match controller must stay backend-agnostic. n.eko's
 * modeline and gutter-crop policy belongs behind this applyViewport seam.
 */
//# sourceMappingURL=viewport-apply.d.ts.map