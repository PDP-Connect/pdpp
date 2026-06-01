import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "@/lib/openspec/filesystem.ts";
import { pdppCliConnectCommand, pdppCliTokenCompletionUnavailable } from "@/lib/pdpp-cli-command.ts";

const SKILL_NAME = "pdpp-data-access";
const SKILL_DESCRIPTION =
  "Use PDPP data through scoped client grants, project-local token caching, and capability-first querying instead of owner bearer tokens.";
const SKILL_BASE_REPO_PATH = "docs/agent-skills/pdpp-data-access";
const WELL_KNOWN_BASE_PATH = "/.well-known/skills";
const LEADING_SLASHES = /^\/+/;

interface AgentSkillFileDefinition {
  readonly mediaType: string;
  readonly repoRelativePath: string;
  readonly routePath: string;
}

const SKILL_FILES: readonly AgentSkillFileDefinition[] = [
  {
    routePath: `${SKILL_NAME}/SKILL.md`,
    repoRelativePath: `${SKILL_BASE_REPO_PATH}/SKILL.md`,
    mediaType: "text/markdown; charset=utf-8",
  },
  {
    routePath: `${SKILL_NAME}/references/grant-design.md`,
    repoRelativePath: `${SKILL_BASE_REPO_PATH}/references/grant-design.md`,
    mediaType: "text/markdown; charset=utf-8",
  },
  {
    routePath: `${SKILL_NAME}/references/query-cookbook.md`,
    repoRelativePath: `${SKILL_BASE_REPO_PATH}/references/query-cookbook.md`,
    mediaType: "text/markdown; charset=utf-8",
  },
  {
    routePath: `${SKILL_NAME}/references/security.md`,
    repoRelativePath: `${SKILL_BASE_REPO_PATH}/references/security.md`,
    mediaType: "text/markdown; charset=utf-8",
  },
  {
    routePath: `${SKILL_NAME}/references/troubleshooting.md`,
    repoRelativePath: `${SKILL_BASE_REPO_PATH}/references/troubleshooting.md`,
    mediaType: "text/markdown; charset=utf-8",
  },
];

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
  readonly skills: readonly [
    {
      readonly canonical_source: "docs/agent-skills";
      readonly description: string;
      readonly files: readonly AgentSkillCatalogFile[];
      readonly name: typeof SKILL_NAME;
      readonly recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog";
    },
  ];
  readonly version: "2026-04-26";
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function catalogUrl(origin: string, routePath: string): string {
  return `${normalizeOrigin(origin)}${WELL_KNOWN_BASE_PATH}/${routePath}`;
}

async function readRepoFile(repoRelativePath: string): Promise<Buffer> {
  const repoRoot = await resolveRepoRoot();
  return fs.readFile(path.join(repoRoot, repoRelativePath));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function buildAgentSkillCatalog(origin: string): Promise<AgentSkillCatalog> {
  const files = await Promise.all(
    SKILL_FILES.map(async (file): Promise<AgentSkillCatalogFile> => {
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

  return {
    object: "agent_skill_catalog",
    version: "2026-04-26",
    skills: [
      {
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        canonical_source: "docs/agent-skills",
        recommended_install: "npx skills add <repo-url> -g when supported; otherwise fetch files from this catalog",
        files,
      },
    ],
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

export function agentSkillsLLMSIndex(): string {
  return [
    "## Agent Skills",
    "",
    `- ${SKILL_NAME}: ${WELL_KNOWN_BASE_PATH}/${SKILL_NAME}/SKILL.md`,
    `- Skill catalog: ${WELL_KNOWN_BASE_PATH}/index.json`,
    `- PDPP CLI connect command: \`${pdppCliConnectCommand}\``,
    "",
    `Use the skill when a coding agent needs PDPP data through scoped client grants. The skill is CLI-first and forbids owner-token use for routine data access. Token completion is ${
      pdppCliTokenCompletionUnavailable ? "not yet public; keep the CLI command gated." : "available through the CLI."
    }`,
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
