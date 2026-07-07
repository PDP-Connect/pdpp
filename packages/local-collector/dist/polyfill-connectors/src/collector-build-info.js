const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";
const COLLECTOR_BUILD_INFO = {
    builtAt: "2026-07-07T07:27:02.483Z",
    revision: "a71a859ba577",
    version: "0.0.0",
};
function buildAgentVersion(info = COLLECTOR_BUILD_INFO) {
    return `${info.version}+${info.revision}`;
}
export { COLLECTOR_BUILD_INFO, COLLECTOR_BUILD_SOURCE_SENTINEL, buildAgentVersion };
