export interface NekoPointerMappingPoint {
  x: number;
  y: number;
}

export interface NekoPointerMappingAlternatives {
  cssViewportOverlay?: NekoPointerMappingPoint | null;
  intrinsicMedia?: NekoPointerMappingPoint | null;
  nekoScreenOverlay?: NekoPointerMappingPoint | null;
}

export interface NekoPointerMappingDiagnosticInput {
  alternativeMappings?: NekoPointerMappingAlternatives | null;
  insideMedia?: boolean;
  insideOverlay?: boolean;
  insideWrapper?: boolean;
  mapped?: NekoPointerMappingPoint | null;
  screenState?: {
    height?: number | unknown;
    width?: number | unknown;
  } | null;
}

export type NekoPointerMappingIssue =
  | "coordinate-space-mismatch"
  | "mapped-outside-screen"
  | "point-outside-media-and-overlay";

export interface DetectNekoPointerMappingIssuesOptions {
  disagreementPx?: number;
}

const NEKO_POINTER_BASIS_DISAGREEMENT_PX = 12;

export function detectNekoPointerMappingIssues(
  snapshot: NekoPointerMappingDiagnosticInput,
  options: DetectNekoPointerMappingIssuesOptions = {}
): NekoPointerMappingIssue[] {
  const reasons: NekoPointerMappingIssue[] = [];
  if (snapshot.insideWrapper === true && snapshot.insideMedia !== true && snapshot.insideOverlay !== true) {
    reasons.push("point-outside-media-and-overlay");
  }
  const mapped = snapshot.mapped ?? null;
  const screenWidth = Number(snapshot.screenState?.width);
  const screenHeight = Number(snapshot.screenState?.height);
  if (
    mapped &&
    Number.isFinite(screenWidth) &&
    Number.isFinite(screenHeight) &&
    (mapped.x < 0 || mapped.y < 0 || mapped.x > screenWidth || mapped.y > screenHeight)
  ) {
    reasons.push("mapped-outside-screen");
  }
  const disagreementPx = options.disagreementPx ?? NEKO_POINTER_BASIS_DISAGREEMENT_PX;
  const alternatives = snapshot.alternativeMappings ?? null;
  if (mapped && alternatives) {
    const screenBasis = alternatives.nekoScreenOverlay;
    if (
      screenBasis &&
      (Math.abs(screenBasis.x - mapped.x) > disagreementPx ||
        Math.abs(screenBasis.y - mapped.y) > disagreementPx)
    ) {
      reasons.push("coordinate-space-mismatch");
    }
  }
  return reasons;
}
