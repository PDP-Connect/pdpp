import { stringifyForJsonl } from "../safe-emit.ts";

process.stdout.write(stringifyForJsonl({ type: "PROGRESS", message: "started but never completed" }));
process.exit(0);
