import { stringifyForJsonl } from "../safe-emit.ts";

process.stdout.write(stringifyForJsonl({ type: "DONE", status: "succeeded", records_emitted: 0 }));
process.exit(1);
