export { CollectorStateReadError, RUNTIME_CAPABILITY_MISMATCH_CODE, RuntimeCapabilityMismatchError, } from "../../polyfill-connectors/src/runner/index.js";
export const ALLOW_CUSTOM_COMMAND_ENV = "PDPP_LOCAL_COLLECTOR_ALLOW_CUSTOM_COMMAND";
export class CollectorCustomCommandRefusedError extends Error {
    code;
    constructor() {
        super(`pdpp-local-collector refuses --command <bin> by default to keep the ` +
            `device-token supply chain narrow. Set ${ALLOW_CUSTOM_COMMAND_ENV}=1 ` +
            `to opt in for monorepo development; see openspec/changes/publish-pdpp-local-collector/design.md §3.`);
        this.name = "CollectorCustomCommandRefusedError";
        this.code = "custom_command_refused";
    }
}
export class CollectorUsageError extends Error {
    exitCode;
    constructor(message, options = {}) {
        super(message);
        this.name = "CollectorUsageError";
        this.exitCode = options.exitCode ?? 64;
    }
}
