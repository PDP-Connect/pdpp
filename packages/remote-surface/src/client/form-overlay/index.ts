import type {
  RemoteSurfaceFormFieldRect,
  RemoteSurfaceFormFieldSnapshot,
} from "../../protocol/index.ts";
import type { CssBox, StreamViewport } from "../geometry.ts";
import { streamViewportRectToClientBox } from "../geometry.ts";
export {
  createFormOverlayReconciliationState,
  formFieldToControlHint,
  planFormOverlaySpecialKeyCommit,
  planFormOverlayValueCommit,
  reconcileFormOverlayFields,
  type FormOverlayCommitOperation,
  type FormOverlayCommitPlan,
  type FormOverlayControlHint,
  type FormOverlayFieldState,
  type FormOverlayReconciliationChange,
  type FormOverlayReconciliationResult,
  type FormOverlayReconciliationState,
} from "./planner.ts";

export interface FieldDetectionSource {
  readSnapshot(): Promise<RemoteSurfaceFormFieldSnapshot> | RemoteSurfaceFormFieldSnapshot;
}

export interface FormOverlayGeometryInput {
  field: Pick<RemoteSurfaceFormFieldRect, "height" | "width" | "x" | "y">;
  imageBox: CssBox;
  viewport: StreamViewport;
}

export function formFieldToOverlayRect(input: FormOverlayGeometryInput): CssBox | null {
  return streamViewportRectToClientBox(input.field, {
    imageBox: input.imageBox,
    viewport: input.viewport,
  });
}
