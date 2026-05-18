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
export type NekoPointerMappingIssue = "coordinate-space-mismatch" | "mapped-outside-screen" | "point-outside-media-and-overlay";
export interface DetectNekoPointerMappingIssuesOptions {
    disagreementPx?: number;
}
export declare function detectNekoPointerMappingIssues(snapshot: NekoPointerMappingDiagnosticInput, options?: DetectNekoPointerMappingIssuesOptions): NekoPointerMappingIssue[];
//# sourceMappingURL=pointer-diagnostics.d.ts.map