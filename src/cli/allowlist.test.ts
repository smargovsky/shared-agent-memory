import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAllowlist,
  ALLOWLIST_RULES,
  removeAllowlist,
  SettingsError,
  settingsPath,
} from "./allowlist.js";

let dir: string;
let file: string;
const now = new Date("2026-10-26T12:00:00.000Z");

function readJson(f: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-settings-"));
  file = path.join(dir, ".claude", "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("settingsPath", () => {
  it("maps scopes to the Claude Code settings files", () => {
    expect(settingsPath("user", { home: "/home/me" })).toBe(
      "/home/me/.claude/settings.json",
    );
    expect(settingsPath("project", { cwd: "/repo" })).toBe("/repo/.claude/settings.json");
  });
});

describe("addAllowlist", () => {
  it("creates the settings file when missing, with no backup", () => {
    const result = addAllowlist(file, now);

    expect(result.changed).toEqual([...ALLOWLIST_RULES]);
    expect(result.backup).toBeUndefined();
    expect(readJson(file).permissions.allow).toEqual([...ALLOWLIST_RULES]);
  });

  it("never allowlists delete or init", () => {
    expect(ALLOWLIST_RULES.some((r) => /delete|init/.test(r))).toBe(false);
  });

  it("keeps every other setting and rule, and backs up first", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = {
      model: "opus",
      permissions: {
        allow: ["Bash(git status)", ALLOWLIST_RULES[0]],
        deny: ["Bash(rm -rf:*)"],
      },
      hooks: { Stop: [] },
    };
    fs.writeFileSync(file, JSON.stringify(original));

    const result = addAllowlist(file, now);

    expect(result.changed).toEqual(ALLOWLIST_RULES.slice(1));
    const after = readJson(file);
    expect(after.model).toBe("opus");
    expect(after.hooks).toEqual({ Stop: [] });
    expect(after.permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(after.permissions.allow).toEqual([
      "Bash(git status)",
      ...ALLOWLIST_RULES,
    ]);
    expect(readJson(result.backup as string)).toEqual(original);
  });

  it("is a no-op the second time: no write, no backup", () => {
    addAllowlist(file, now);
    const before = fs.readFileSync(file, "utf8");

    const second = addAllowlist(file, new Date("2026-10-27T00:00:00.000Z"));

    expect(second.changed).toEqual([]);
    expect(second.backup).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
  });

  it("refuses to touch invalid JSON and prints the rules to add", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ // comment\n}");

    expect(() => addAllowlist(file, now)).toThrow(SettingsError);
    expect(() => addAllowlist(file, now)).toThrow(/agent-memory store:\*/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ // comment\n}");
  });

  it("refuses a permissions.allow that is not an array", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: "nope" } }));

    expect(() => addAllowlist(file, now)).toThrow(/not an array/);
  });

  it("writes through a symlinked settings file and keeps the link", () => {
    const real = path.join(dir, "dotfiles-settings.json");
    fs.writeFileSync(real, JSON.stringify({ model: "opus" }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(real, file);

    addAllowlist(file, now);

    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readJson(real).permissions.allow).toEqual([...ALLOWLIST_RULES]);
    expect(readJson(real).model).toBe("opus");
  });
});

describe("removeAllowlist", () => {
  it("removes only the agent-memory rules", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ permissions: { allow: ["Bash(git status)", ...ALLOWLIST_RULES] } }),
    );

    const result = removeAllowlist(file, now);

    expect(result.changed).toEqual([...ALLOWLIST_RULES]);
    expect(readJson(file).permissions.allow).toEqual(["Bash(git status)"]);
    expect(result.backup).toBeDefined();
  });

  it("is a no-op when there is nothing to remove", () => {
    expect(removeAllowlist(file, now)).toEqual({ file, changed: [] });
    expect(fs.existsSync(file)).toBe(false);
  });
});
