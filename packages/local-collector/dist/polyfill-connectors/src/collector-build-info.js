const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";
const COLLECTOR_BUILD_INFO = {
    builtAt: "2026-06-05T07:48:52.362Z",
    revision: "39f5d46cb5c9",
    version: "0.0.0",
};
function buildAgentVersion(info = COLLECTOR_BUILD_INFO) {
    return `${info.version}+${info.revision}`;
}
export { COLLECTOR_BUILD_INFO, COLLECTOR_BUILD_SOURCE_SENTINEL, buildAgentVersion };
