export function createUnimplementedNekoApplyViewport() {
    return async (viewport) => {
        void viewport;
        throw new Error("n.eko applyViewport is not implemented yet; wire aligned modeline snapping, Browser.setWindowBounds, and gutter-crop reporting here");
    };
}
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
//# sourceMappingURL=viewport-apply.js.map