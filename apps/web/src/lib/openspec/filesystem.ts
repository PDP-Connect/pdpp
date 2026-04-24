import { promises as fs } from "node:fs";
import path from "node:path";

let cachedRepoRoot: string | null = null;
let cachedGitMetadataManifest: Promise<OpenSpecGitMetadataManifest | null> | null = null;

type OpenSpecGitMetadataEntry = {
  createdAt: string | null;
  updatedAt: string | null;
  tracked: boolean;
  source: "git" | "filesystem";
};

type OpenSpecGitMetadataManifest = {
  generatedAt: string;
  repoRoot: string;
  shallow: boolean;
  files: Record<string, OpenSpecGitMetadataEntry>;
};

export async function resolveRepoRoot(): Promise<string> {
  if (cachedRepoRoot) {
    return cachedRepoRoot;
  }

  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (true) {
    const hasWorkspace = await fileExists(path.join(dir, "pnpm-workspace.yaml"));
    const hasOpenSpec = await dirExists(path.join(dir, "openspec"));
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

  throw new Error(
    `OpenSpec loader: could not resolve repo root from ${process.cwd()} ` +
      "(needs a directory containing both pnpm-workspace.yaml and openspec/)."
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function listSubdirectories(absDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function listMarkdownFiles(absDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export type RawArtifact = {
  markdown: string;
  absolutePath: string;
  repoRelativePath: string;
  createdAt: string | null;
  lastModified: string | null;
};

function openSpecGitMetadataPath(repoRoot: string): string {
  return path.join(repoRoot, "apps/web/.generated/openspec-git-metadata.json");
}

async function loadOpenSpecGitMetadataManifest(repoRoot: string): Promise<OpenSpecGitMetadataManifest | null> {
  if (!cachedGitMetadataManifest) {
    cachedGitMetadataManifest = fs
      .readFile(openSpecGitMetadataPath(repoRoot), "utf8")
      .then((raw) => JSON.parse(raw) as OpenSpecGitMetadataManifest)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          return null;
        }
        throw err;
      });
  }

  return cachedGitMetadataManifest;
}

async function readOpenSpecGitMetadataEntry(
  repoRoot: string,
  repoRelativePath: string
): Promise<OpenSpecGitMetadataEntry | null> {
  const manifest = await loadOpenSpecGitMetadataManifest(repoRoot);
  return manifest?.files[toPosix(repoRelativePath)] ?? null;
}

export async function readArtifactIfExists(repoRoot: string, repoRelativePath: string): Promise<RawArtifact | null> {
  const absolutePath = path.join(repoRoot, repoRelativePath);
  try {
    const [markdown, stat, gitMetadata] = await Promise.all([
      fs.readFile(absolutePath, "utf8"),
      fs.stat(absolutePath),
      readOpenSpecGitMetadataEntry(repoRoot, repoRelativePath),
    ]);
    return {
      markdown,
      absolutePath,
      repoRelativePath: toPosix(repoRelativePath),
      createdAt: gitMetadata?.createdAt ?? null,
      lastModified: gitMetadata?.updatedAt ?? stat.mtime.toISOString(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function fileExistsAt(repoRoot: string, repoRelativePath: string): Promise<boolean> {
  return fileExists(path.join(repoRoot, repoRelativePath));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function specPathFor(capability: string): string {
  return path.posix.join("openspec/specs", capability, "spec.md");
}

export function changeArtifactPath(changeName: string, filename: "proposal.md" | "design.md" | "tasks.md"): string {
  return path.posix.join("openspec/changes", changeName, filename);
}

export function changeSpecDeltaPath(changeName: string, capability: string): string {
  return path.posix.join("openspec/changes", changeName, "specs", capability, "spec.md");
}

export function changeDesignNotesDir(changeName: string): string {
  return path.posix.join("openspec/changes", changeName, "design-notes");
}

export function changeDesignNotePath(changeName: string, noteFilename: string): string {
  return path.posix.join(changeDesignNotesDir(changeName), noteFilename);
}

export async function listChangeNames(repoRoot: string): Promise<string[]> {
  return listSubdirectories(path.join(repoRoot, "openspec/changes"));
}

export async function listSpecCapabilities(repoRoot: string): Promise<string[]> {
  return listSubdirectories(path.join(repoRoot, "openspec/specs"));
}

export async function listChangeSpecCapabilities(repoRoot: string, changeName: string): Promise<string[]> {
  return listSubdirectories(path.join(repoRoot, "openspec/changes", changeName, "specs"));
}

export async function listChangeDesignNoteFiles(repoRoot: string, changeName: string): Promise<string[]> {
  return listMarkdownFiles(path.join(repoRoot, "openspec/changes", changeName, "design-notes"));
}
