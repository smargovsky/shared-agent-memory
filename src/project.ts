import { execFileSync } from "child_process";
import path from "path";

const GIT_TIMEOUT_MS = 5_000;

/** Repo name from a git remote URL: `https://github.com/u/my-app.git` and `git@host:team/my-app.git` both give `my-app`. */
export function projectFromRemoteUrl(remote: string): string | null {
  const match = remote.trim().match(/[/:]([^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

/** Project name from the `origin` remote of the git repo containing `cwd`, or null outside a repo. */
export function getProjectFromGitRemote(cwd?: string): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    return projectFromRemoteUrl(remote);
  } catch {
    return null;
  }
}

/**
 * Project that new memories go to when the caller doesn't name one.
 * Order: explicit flag, then DEFAULT_PROJECT, then the git remote, then the folder name.
 * DEFAULT_PROJECT sits above the git remote because it is documented as an override.
 */
export function resolveDefaultProject(
  options: {
    flag?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    gitLookup?: (cwd?: string) => string | null;
  } = {},
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? env.PWD ?? process.cwd();
  const gitLookup = options.gitLookup ?? getProjectFromGitRemote;

  if (options.flag) return options.flag;
  if (env.DEFAULT_PROJECT) return env.DEFAULT_PROJECT;
  const gitProject = gitLookup(cwd);
  if (gitProject) return gitProject;
  return path.basename(cwd) || "default";
}
