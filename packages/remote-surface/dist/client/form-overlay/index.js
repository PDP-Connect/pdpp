import { streamViewportRectToClientBox } from "../geometry.js";
export { createFormOverlayReconciliationState, formFieldToControlHint, planFormOverlaySpecialKeyCommit, planFormOverlayValueCommit, reconcileFormOverlayFields, } from "./planner.js";
export function formFieldToOverlayRect(input) {
    return streamViewportRectToClientBox(input.field, {
        imageBox: input.imageBox,
        viewport: input.viewport,
    });
}
//# sourceMappingURL=index.js.map