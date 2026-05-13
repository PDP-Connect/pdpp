export interface NekoViewportLayout {
  screenHeight: number;
  screenWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}

export type NekoMediaIntrinsicCompatibility =
  | "aspect-compatible"
  | "aspect-mismatch"
  | "dimension-compatible"
  | "missing-intrinsic"
  | "missing-intrinsic-and-screen"
  | "missing-size"
  | "orientation-mismatch"
  | "screen-missing";

export interface NekoMediaSizeSelection {
  height: number;
  intrinsicCompatibility: NekoMediaIntrinsicCompatibility;
  source: "intrinsic" | "screen" | "viewport";
  width: number;
}

export interface NekoMediaDisplaySelection extends NekoMediaSizeSelection {
  fit: "contain" | "cover";
  settling: boolean;
}

export interface NekoScreenStateSizeSelection {
  height: number;
  source: "current" | NekoMediaSizeSelection["source"];
  width: number;
}

const MEDIA_SCREEN_ASPECT_TOLERANCE_RATIO = 0.12;
const MEDIA_SCREEN_DIMENSION_TOLERANCE_PX = 24;
const MEDIA_SCREEN_DIMENSION_TOLERANCE_RATIO = 0.08;

function validSize(size: { height: number; width: number }): boolean {
  return size.width > 0 && size.height > 0;
}

function sizeAspect(size: { height: number; width: number }): number {
  return size.width / size.height;
}

function sizeOrientation(size: { height: number; width: number }): "landscape" | "portrait" | "square" {
  const longestSide = Math.max(size.width, size.height);
  if (longestSide <= 0 || Math.abs(size.width - size.height) / longestSide <= 0.05) {
    return "square";
  }
  return size.width > size.height ? "landscape" : "portrait";
}

function sizeOrientationCompatible(
  a: { height: number; width: number },
  b: { height: number; width: number }
): boolean {
  const aOrientation = sizeOrientation(a);
  const bOrientation = sizeOrientation(b);
  return aOrientation === "square" || bOrientation === "square" || aOrientation === bOrientation;
}

function dimensionsClose(
  candidate: { height: number; width: number },
  expected: { height: number; width: number }
): boolean {
  const widthTolerance = Math.max(
    MEDIA_SCREEN_DIMENSION_TOLERANCE_PX,
    expected.width * MEDIA_SCREEN_DIMENSION_TOLERANCE_RATIO
  );
  const heightTolerance = Math.max(
    MEDIA_SCREEN_DIMENSION_TOLERANCE_PX,
    expected.height * MEDIA_SCREEN_DIMENSION_TOLERANCE_RATIO
  );
  return (
    Math.abs(candidate.width - expected.width) <= widthTolerance &&
    Math.abs(candidate.height - expected.height) <= heightTolerance
  );
}

function intrinsicCompatibility(
  intrinsic: { height: number; width: number },
  screen: { height: number; width: number }
): NekoMediaIntrinsicCompatibility {
  if (!(validSize(intrinsic) && validSize(screen))) {
    return "missing-size";
  }
  if (!sizeOrientationCompatible(intrinsic, screen)) {
    return "orientation-mismatch";
  }
  if (dimensionsClose(intrinsic, screen)) {
    return "dimension-compatible";
  }
  const aspectDelta = Math.abs(sizeAspect(intrinsic) - sizeAspect(screen)) / sizeAspect(screen);
  return aspectDelta <= MEDIA_SCREEN_ASPECT_TOLERANCE_RATIO ? "aspect-compatible" : "aspect-mismatch";
}

export function selectNekoMediaSizeForLayout(
  layout: NekoViewportLayout,
  intrinsic: { height: number; width: number } | null
): NekoMediaSizeSelection {
  const viewport = { height: layout.viewportHeight, width: layout.viewportWidth };
  const screen = { height: layout.screenHeight, width: layout.screenWidth };
  if (intrinsic && validSize(intrinsic)) {
    const compatibility = intrinsicCompatibility(intrinsic, screen);
    if (compatibility !== "orientation-mismatch" && compatibility !== "aspect-mismatch") {
      return { ...intrinsic, intrinsicCompatibility: compatibility, source: "intrinsic" };
    }
    if (compatibility === "aspect-mismatch") {
      return { ...intrinsic, intrinsicCompatibility: compatibility, source: "intrinsic" };
    }
    if (validSize(screen)) {
      return { ...screen, intrinsicCompatibility: compatibility, source: "screen" };
    }
    return { ...intrinsic, intrinsicCompatibility: "screen-missing", source: "intrinsic" };
  }
  if (validSize(screen)) {
    return { ...screen, intrinsicCompatibility: "missing-intrinsic", source: "screen" };
  }
  return { ...viewport, intrinsicCompatibility: "missing-intrinsic-and-screen", source: "viewport" };
}

export function selectNekoMediaDisplayForLayout(
  layout: NekoViewportLayout,
  intrinsic: { height: number; width: number } | null
): NekoMediaDisplaySelection {
  const selected = selectNekoMediaSizeForLayout(layout, intrinsic);
  if (
    intrinsic &&
    validSize(intrinsic) &&
    (selected.intrinsicCompatibility === "orientation-mismatch" ||
      selected.intrinsicCompatibility === "aspect-mismatch")
  ) {
    return {
      ...intrinsic,
      fit: "cover",
      intrinsicCompatibility: selected.intrinsicCompatibility,
      settling: true,
      source: "intrinsic",
    };
  }
  return {
    ...selected,
    fit: "cover",
    settling: false,
  };
}

export function selectNekoScreenStateSizeForLayout(
  layout: NekoViewportLayout,
  intrinsic: { height: number; width: number } | null,
  currentScreen: { height: number; width: number } | null,
  allowRequestedScreenSize: boolean
): NekoScreenStateSizeSelection {
  const display = selectNekoMediaDisplayForLayout(layout, intrinsic);
  if (display.source === "intrinsic" || allowRequestedScreenSize) {
    return { height: display.height, source: display.source, width: display.width };
  }
  if (currentScreen && validSize(currentScreen)) {
    return { height: currentScreen.height, source: "current", width: currentScreen.width };
  }
  return { height: display.height, source: display.source, width: display.width };
}
