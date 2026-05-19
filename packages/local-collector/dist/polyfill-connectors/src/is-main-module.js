import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
export function isMainModule(importMetaUrl) {
    const entry = process.argv[1];
    if (!entry) {
        return false;
    }
    if (importMetaUrl === pathToFileURL(entry).href) {
        return true;
    }
    try {
        return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
    }
    catch {
        return false;
    }
}
