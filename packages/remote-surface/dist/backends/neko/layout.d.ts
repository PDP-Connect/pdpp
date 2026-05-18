export interface NekoViewportLayout {
    screenHeight: number;
    screenWidth: number;
    viewportHeight: number;
    viewportWidth: number;
}
export type NekoMediaIntrinsicCompatibility = "aspect-compatible" | "aspect-mismatch" | "dimension-compatible" | "missing-intrinsic" | "missing-intrinsic-and-screen" | "missing-size" | "orientation-mismatch" | "screen-missing";
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
export declare function selectNekoMediaSizeForLayout(layout: NekoViewportLayout, intrinsic: {
    height: number;
    width: number;
} | null): NekoMediaSizeSelection;
export declare function selectNekoMediaDisplayForLayout(layout: NekoViewportLayout, intrinsic: {
    height: number;
    width: number;
} | null): NekoMediaDisplaySelection;
export declare function selectNekoScreenStateSizeForLayout(layout: NekoViewportLayout, intrinsic: {
    height: number;
    width: number;
} | null, currentScreen: {
    height: number;
    width: number;
} | null, allowRequestedScreenSize: boolean): NekoScreenStateSizeSelection;
//# sourceMappingURL=layout.d.ts.map