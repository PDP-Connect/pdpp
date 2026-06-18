const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";
const COLLECTOR_BUILD_INFO = {
    builtAt: "2026-06-18T00:44:39.053Z",
    revision: "36131e17f865",
    version: "0.0.0",
};
function buildAgentVersion(info = COLLECTOR_BUILD_INFO) {
    return `${info.version}+${info.revision}`;
}
export { COLLECTOR_BUILD_INFO, COLLECTOR_BUILD_SOURCE_SENTINEL, buildAgentVersion };
