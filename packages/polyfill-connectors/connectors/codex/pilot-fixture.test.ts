import { registerPilotFixtureTests } from "../../src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({ connector: "codex", validateRecord });
