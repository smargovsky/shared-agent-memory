import { describe, expect, it } from "vitest";
import { projectFromRemoteUrl, resolveDefaultProject } from "./project.js";

describe("projectFromRemoteUrl", () => {
  it.each([
    ["https://github.com/user/my-app.git", "my-app"],
    ["https://github.com/user/my-app", "my-app"],
    ["https://github.com/user/my-app/", "my-app"],
    ["git@bitbucket.org:team/backend.git", "backend"],
    ["git@personal:smargovsky/shared-agent-memory.git\n", "shared-agent-memory"],
  ])("%s -> %s", (remote, expected) => {
    expect(projectFromRemoteUrl(remote)).toBe(expected);
  });

  it("returns null for something that is not a URL", () => {
    expect(projectFromRemoteUrl("")).toBeNull();
  });
});

describe("resolveDefaultProject", () => {
  const inRepo = () => "repo-project";
  const outsideRepo = () => null;

  it("prefers the explicit flag over everything", () => {
    expect(
      resolveDefaultProject({
        flag: "from-flag",
        env: { DEFAULT_PROJECT: "from-env" },
        cwd: "/work/folder",
        gitLookup: inRepo,
      }),
    ).toBe("from-flag");
  });

  it("lets DEFAULT_PROJECT override the git remote", () => {
    expect(
      resolveDefaultProject({
        env: { DEFAULT_PROJECT: "from-env" },
        cwd: "/work/folder",
        gitLookup: inRepo,
      }),
    ).toBe("from-env");
  });

  it("treats an empty DEFAULT_PROJECT as unset", () => {
    expect(
      resolveDefaultProject({
        env: { DEFAULT_PROJECT: "" },
        cwd: "/work/folder",
        gitLookup: inRepo,
      }),
    ).toBe("repo-project");
  });

  it("uses the git remote of the given cwd", () => {
    let seenCwd: string | undefined;
    const project = resolveDefaultProject({
      env: {},
      cwd: "/work/folder",
      gitLookup: (cwd) => {
        seenCwd = cwd;
        return "repo-project";
      },
    });

    expect(project).toBe("repo-project");
    expect(seenCwd).toBe("/work/folder");
  });

  it("falls back to the folder name outside a git repo", () => {
    expect(
      resolveDefaultProject({
        env: {},
        cwd: "/work/folder",
        gitLookup: outsideRepo,
      }),
    ).toBe("folder");
  });

  it("falls back to PWD when no cwd is given", () => {
    expect(
      resolveDefaultProject({
        env: { PWD: "/home/me/from-pwd" },
        gitLookup: outsideRepo,
      }),
    ).toBe("from-pwd");
  });

  it("uses 'default' at the filesystem root", () => {
    expect(
      resolveDefaultProject({ env: {}, cwd: "/", gitLookup: outsideRepo }),
    ).toBe("default");
  });
});
