export declare const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";
export interface CollectorBuildInfo {
    builtAt: string | null;
    revision: string;
    version: string;
}
export declare const COLLECTOR_BUILD_INFO: CollectorBuildInfo;
export declare function buildAgentVersion(info?: CollectorBuildInfo): string;
