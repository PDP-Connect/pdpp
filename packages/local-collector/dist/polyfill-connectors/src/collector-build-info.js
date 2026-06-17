const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";
const COLLECTOR_BUILD_INFO = {
    builtAt: "2026-06-17T23:14:52.745Z",
    revision: "d80e01dc384e",
    version: "0.0.0",
};
function buildAgentVersion(info = COLLECTOR_BUILD_INFO) {
    return `${info.version}+${info.revision}`;
}
export { COLLECTOR_BUILD_INFO, COLLECTOR_BUILD_SOURCE_SENTINEL, buildAgentVersion };
