import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appRoot, "..", "..");

const read = (path) => readFileSync(join(repoRoot, path), "utf8").replace(/\s*$/u, "");
const write = (path, value) => {
  const output = join(appRoot, path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${value}\n`);
};

const specification = (source, description) => {
  const lines = read(source).split("\n");
  const title = lines[0]?.replace(/^#\s+/u, "");
  const status = lines[2]?.replace(/^Status:\s*/u, "");
  const date = lines[3]?.replace(/^Date:\s*/u, "");
  if (!(title && status && date)) {
    throw new Error(`Unexpected canonical header in ${source}`);
  }
  const body = lines.slice(4).join("\n").replace(/^\s*---\s*/u, "");
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n> **Spec status**\n>\n> Status: **${status}**\n>\n> Date: ${date}\n\n${body}`;
};

write(
  "content/specification/spec-core.md",
  specification(
    "spec-core.md",
    "Authorization and disclosure semantics for personal data — record model, selection request, grant, manifest, and resource server interface."
  )
);
write(
  "content/specification/spec-discovery-and-trust.md",
  specification(
    "spec-discovery-and-trust.md",
    "How an authorization server discovers, retrieves, validates, and accepts a source declaration."
  )
);
write(
  "content/specification/spec-collection-profile.md",
  specification(
    "spec-collection-profile.md",
    "Optional collection semantics for sources that do not expose PDPP natively."
  )
);
write(
  "content/specification/index.md",
  "---\ntitle: Protocol Specification\ndescription: Canonical PDPP specification texts rendered from the repository root.\n---\n\n# Protocol Specification\n\n- [Core](/specification/spec-core)\n- [Source Declaration Discovery and Trust](/specification/spec-discovery-and-trust)"
);

const governance = read("GOVERNANCE.md").split("\n");
const governanceTitle = governance.shift()?.replace(/^#\s+/u, "");
if (!governanceTitle) {
  throw new Error("Unexpected canonical header in GOVERNANCE.md");
}
write(
  "content/governance.md",
  `---\ntitle: ${JSON.stringify(governanceTitle)}\ndescription: Canonical PDP-Connect programme governance text rendered from the repository root.\n---\n\n${governance.join("\n").replace(/^\s+/u, "")}`
);
