import { pathToFileURL } from "node:url";
export function isMainModule(importMetaUrl) {
    const entry = process.argv[1];
    if (!entry) {
        return false;
    }
    return importMetaUrl === pathToFileURL(entry).href;
}
