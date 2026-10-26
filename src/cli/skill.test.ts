import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(
  here,
  "../../plugins/agent-memory-cli/skills/shared-memory/SKILL.md",
);
const RUN = path.resolve(here, "run.ts");

const skill = fs.readFileSync(SKILL, "utf8");
const runSource = fs.readFileSync(RUN, "utf8");

describe("shared-memory skill", () => {
  it("has name and description frontmatter", () => {
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(front).not.toBeNull();
    expect(front?.[1]).toMatch(/^name: shared-memory$/m);
    expect(front?.[1]).toMatch(/^description: .{50,}$/m);
  });

  it("only names commands the CLI implements", () => {
    const commands = new Set(
      [...skill.matchAll(/agent-memory ([a-z]+)/g)].map((m) => m[1]),
    );
    expect(commands.size).toBeGreaterThan(0);
    for (const command of commands) {
      const implemented =
        command === "init" || command === "help"
          ? true
          : runSource.includes(`case "${command}":`);
      expect(implemented, `agent-memory ${command}`).toBe(true);
    }
  });

  it("only uses flags the CLI parses", () => {
    const flags = new Set([...skill.matchAll(/ (--[a-z][a-z-]*)/g)].map((m) => m[1]));
    for (const flag of flags) {
      expect(runSource.includes(`"${flag}"`), flag).toBe(true);
    }
  });

  it("never shows memory text passed as an argument", () => {
    for (const m of skill.matchAll(/agent-memory (store|update)[^\n]*/g)) {
      expect(m[0], m[0]).toMatch(/<<'[A-Z]+'$/);
    }
  });
});
