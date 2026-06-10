import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pdppCliConnectCommand, pdppCliTokenCompletionUnavailable } from "../pdpp-cli-command.ts";

const DATA_ACCESS_SKILL_NAME = "pdpp-data-access";
const DATA_ACCESS_SKILL_DESCRIPTION =
  "Use PDPP data through scoped client grants, project-local token caching, and capability-first querying instead of owner bearer tokens.";
const DATA_ACCESS_SKILL_BASE_REPO_PATH = "docs/agent-skills/pdpp-data-access";
const OWNER_AGENT_SKILL_NAME = "pdpp-owner-agent";
const OWNER_AGENT_SKILL_DESCRIPTION =
  "Use PDPP as trusted owner-level local automation through browser-mediated owner approval, local credential storage, and token-efficient REST sync.";
const OWNER_AGENT_SKILL_BASE_REPO_PATH = "docs/agent-skills/pdpp-owner-agent";
const WELL_KNOWN_BASE_PATH = "/.well-known/skills";
const OWNER_AGENT_SKILL_ROUTE_PATH = `${OWNER_AGENT_SKILL_NAME}/SKILL.md`;
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_ENDPOINT_PATH = "/mcp";
const LEADING_SLASHES = /^\/+/;

let cachedRepoRoot: string | null = null;

interface AgentSkillFileDefinition {
  readonly mediaType: string;
  readonly repoRelativePath: string;
  readonly routePath: string;
}

interface AgentSkillDefinition {
  readonly canonical_source: "docs/agent-skills";
  readonly description: string;
  readonly files: readonly AgentSkillFileDefinition[];
  readonly name: string;
  readonly recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog";
}

const SKILLS: readonly AgentSkillDefinition[] = [
  {
    name: DATA_ACCESS_SKILL_NAME,
    description: DATA_ACCESS_SKILL_DESCRIPTION,
    canonical_source: "docs/agent-skills",
    recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog",
    files: [
      {
        routePath: `${DATA_ACCESS_SKILL_NAME}/SKILL.md`,
        repoRelativePath: `${DATA_ACCESS_SKILL_BASE_REPO_PATH}/SKILL.md`,
        mediaType: "text/markdown; charset=utf-8",
      },
      {
        routePath: `${DATA_ACCESS_SKILL_NAME}/references/grant-design.md`,
        repoRelativePath: `${DATA_ACCESS_SKILL_BASE_REPO_PATH}/references/grant-design.md`,
        mediaType: "text/markdown; charset=utf-8",
      },
      {
        routePath: `${DATA_ACCESS_SKILL_NAME}/references/query-cookbook.md`,
        repoRelativePath: `${DATA_ACCESS_SKILL_BASE_REPO_PATH}/references/query-cookbook.md`,
        mediaType: "text/markdown; charset=utf-8",
      },
      {
        routePath: `${DATA_ACCESS_SKILL_NAME}/references/security.md`,
        repoRelativePath: `${DATA_ACCESS_SKILL_BASE_REPO_PATH}/references/security.md`,
        mediaType: "text/markdown; charset=utf-8",
      },
      {
        routePath: `${DATA_ACCESS_SKILL_NAME}/references/troubleshooting.md`,
        repoRelativePath: `${DATA_ACCESS_SKILL_BASE_REPO_PATH}/references/troubleshooting.md`,
        mediaType: "text/markdown; charset=utf-8",
      },
    ],
  },
  {
    name: OWNER_AGENT_SKILL_NAME,
    description: OWNER_AGENT_SKILL_DESCRIPTION,
    canonical_source: "docs/agent-skills",
    recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog",
    files: [
      {
        routePath: OWNER_AGENT_SKILL_ROUTE_PATH,
        repoRelativePath: `${OWNER_AGENT_SKILL_BASE_REPO_PATH}/SKILL.md`,
        mediaType: "text/markdown; charset=utf-8",
      },
    ],
  },
];

const SKILL_FILES: readonly AgentSkillFileDefinition[] = SKILLS.flatMap((skill) => skill.files);

export interface AgentSkillCatalogFile {
  readonly bytes: number;
  readonly media_type: string;
  readonly path: string;
  readonly repo_path: string;
  readonly sha256: string;
  readonly url: string;
}

export interface AgentSkillCatalog {
  readonly object: "agent_skill_catalog";
  readonly skills: readonly AgentSkillCatalogSkill[];
  readonly version: "2026-04-26";
}

export interface AgentSkillCatalogSkill {
  readonly canonical_source: "docs/agent-skills";
  readonly description: string;
  readonly files: readonly AgentSkillCatalogFile[];
  readonly name: string;
  readonly recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog";
}

async function pathExists(absPath: string, kind: "file" | "dir"): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

async function resolveRepoRoot(): Promise<string> {
  if (cachedRepoRoot) {
    return cachedRepoRoot;
  }

  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (true) {
    const hasWorkspace = await pathExists(path.join(dir, "pnpm-workspace.yaml"), "file");
    const hasOpenSpec = await pathExists(path.join(dir, "openspec"), "dir");
    if (hasWorkspace && hasOpenSpec) {
      cachedRepoRoot = dir;
      return dir;
    }
    if (dir === root) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(`Could not resolve PDPP repo root from ${process.cwd()}`);
}

async function readRepoFile(repoRelativePath: string): Promise<Buffer> {
  const repoRoot = await resolveRepoRoot();
  return fs.readFile(path.join(repoRoot, repoRelativePath));
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function catalogUrl(origin: string, routePath: string): string {
  return `${normalizeOrigin(origin)}${WELL_KNOWN_BASE_PATH}/${routePath}`;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function buildAgentSkillCatalog(origin: string): Promise<AgentSkillCatalog> {
  const skills = await Promise.all(
    SKILLS.map(async (skill): Promise<AgentSkillCatalogSkill> => {
      const files = await Promise.all(
        skill.files.map(async (file): Promise<AgentSkillCatalogFile> => {
          const bytes = await readRepoFile(file.repoRelativePath);
          return {
            path: file.routePath,
            repo_path: file.repoRelativePath,
            media_type: file.mediaType,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
            url: catalogUrl(origin, file.routePath),
          };
        })
      );
      return { ...skill, files };
    })
  );

  return {
    object: "agent_skill_catalog",
    version: "2026-04-26",
    skills,
  };
}

export async function readAgentSkillFile(routePath: string): Promise<{
  readonly body: Buffer;
  readonly definition: AgentSkillFileDefinition;
} | null> {
  const normalized = routePath.replace(LEADING_SLASHES, "");
  const definition = SKILL_FILES.find((file) => file.routePath === normalized);
  if (!definition) {
    return null;
  }
  return {
    body: await readRepoFile(definition.repoRelativePath),
    definition,
  };
}

export function ownerAgentOnboardingLLMSIndex(): string {
  return [
    "## Trusted owner-agent onboarding (owner-level local automation)",
    "",
    "Only for a local agent the operator has explicitly authorized to act as themselves (e.g. a local assistant such as Daisy). Routine third-party, coding-agent, and task-scoped assistants are NOT this profile - they use the grant-scoped `pdpp-data-access` skill above.",
    "",
    `- Canonical onboarding metadata: ${PROTECTED_RESOURCE_METADATA_PATH} on this operator origin. When owner-agent onboarding is enabled, the \`pdpp_owner_agent_onboarding\` advisory block names every surface (owner approval / device authorization, token, schema, streams, query base, introspection, revocation, event subscriptions).`,
    `- Owner-agent onboarding guidance: ${WELL_KNOWN_BASE_PATH}/${OWNER_AGENT_SKILL_ROUTE_PATH}`,
    `- Grant-scoped MCP (ordinary external clients, not owner agents): ${MCP_ENDPOINT_PATH} - \`/mcp\` rejects owner bearers by design.`,
    "- REST/CLI owner-agent guidance: use the owner bearer only on owner-supported `/v1/**` REST routes; the `pdpp owner-agent onboard <entrypoint>` CLI runs the browser-mediated flow without printing the bearer.",
    "",
    "Do not paste tokens. Owner approval happens in a browser/dashboard flow; the credential is written to a local credential target. Never ask the operator to paste a bearer into chat or a terminal, and never echo or log the bearer.",
  ].join("\n");
}

export function agentSkillsLLMSIndex(): string {
  return [
    "## Agent Skills",
    "",
    `- ${DATA_ACCESS_SKILL_NAME}: ${WELL_KNOWN_BASE_PATH}/${DATA_ACCESS_SKILL_NAME}/SKILL.md`,
    `- ${OWNER_AGENT_SKILL_NAME}: ${WELL_KNOWN_BASE_PATH}/${OWNER_AGENT_SKILL_ROUTE_PATH}`,
    `- Skill catalog: ${WELL_KNOWN_BASE_PATH}/index.json`,
    `- PDPP CLI connect command: \`${pdppCliConnectCommand}\``,
    "",
    `Use the skill when a coding agent needs PDPP data through scoped client grants. The skill is CLI-first and forbids owner-token use for routine data access. Token completion is ${
      pdppCliTokenCompletionUnavailable ? "not yet public; keep the CLI command gated." : "available through the CLI."
    }`,
    "",
    ownerAgentOnboardingLLMSIndex(),
  ].join("\n");
}

export async function agentSkillsLLMSFullText(): Promise<string> {
  const parts = await Promise.all(
    SKILL_FILES.map(async (file) => {
      const body = await readRepoFile(file.repoRelativePath);
      return [`## ${file.repoRelativePath}`, "", body.toString("utf8")].join("\n");
    })
  );
  return ["# Agent Skills", "", ...parts].join("\n\n");
}
