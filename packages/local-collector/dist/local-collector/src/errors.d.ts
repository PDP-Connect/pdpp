export { CollectorStateReadError, RUNTIME_CAPABILITY_MISMATCH_CODE, RuntimeCapabilityMismatchError, } from "../../polyfill-connectors/src/runner/index.js";
export declare const ALLOW_CUSTOM_COMMAND_ENV = "PDPP_LOCAL_COLLECTOR_ALLOW_CUSTOM_COMMAND";
export declare class CollectorCustomCommandRefusedError extends Error {
    readonly code: "custom_command_refused";
    constructor();
}
export declare class CollectorUsageError extends Error {
    readonly exitCode: number;
    constructor(message: string, options?: {
        exitCode?: number;
    });
}
