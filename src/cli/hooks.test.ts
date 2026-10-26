import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPACT_RESUME_CONTEXT,
  parseHookInput,
  SESSION_START_CONTEXT,
  sessionStartOutput,
  stateDir,
  TURN_CONTEXT,
  turnOutput,
} from "./hooks.js";
import { CliIO, EXIT, run } from "./run.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-hooks-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseHookInput", () => {
  it("reads session_id and source and ignores garbage", () => {
    expect(parseHookInput('{"session_id":"s1","source":"compact","x":1}')).toEqual({
      session_id: "s1",
      source: "compact",
    });
    expect(parseHookInput("not json")).toEqual({});
    expect(parseHookInput(null)).toEqual({});
    expect(parseHookInput('{"session_id":5}')).toEqual({ session_id: undefined, source: undefined });
  });
});

describe("sessionStartOutput", () => {
  it("returns the guidance as additionalContext, not systemMessage", () => {
    const out = sessionStartOutput({ source: "startup" });

    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: SESSION_START_CONTEXT,
      },
    });
    expect(out).not.toHaveProperty("systemMessage");
  });

  it("adds the resume prompt only after compaction", () => {
    expect(sessionStartOutput({ source: "compact" }).hookSpecificOutput.additionalContext).toBe(
      `${SESSION_START_CONTEXT}\n${COMPACT_RESUME_CONTEXT}`,
    );
    expect(
      sessionStartOutput({ source: "resume" }).hookSpecificOutput.additionalContext,
    ).not.toContain("compacted");
  });

  it("uses CLI commands, not MCP tool names", () => {
    for (const text of [SESSION_START_CONTEXT, COMPACT_RESUME_CONTEXT, TURN_CONTEXT]) {
      expect(text).not.toMatch(/search_memory|store_memory|update_memory|load_memories/);
      expect(text).toContain("agent-memory");
    }
  });
});

describe("turnOutput", () => {
  it("nudges on every Nth prompt per session", () => {
    const fired = Array.from({ length: 6 }, () =>
      turnOutput({ session_id: "s1" }, { interval: 3, dir }),
    ).map((o) => o !== null);

    expect(fired).toEqual([false, false, true, false, false, true]);
    expect(
      turnOutput({ session_id: "s1" }, { interval: 3, dir: path.join(dir, "x") }),
    ).toBeNull();
  });

  it("counts sessions separately", () => {
    turnOutput({ session_id: "a" }, { interval: 2, dir });
    expect(turnOutput({ session_id: "b" }, { interval: 2, dir })).toBeNull();
    expect(turnOutput({ session_id: "a" }, { interval: 2, dir })).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: TURN_CONTEXT },
    });
  });

  it("stays quiet without a session id", () => {
    expect(turnOutput({}, { interval: 1, dir })).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps session ids from escaping the state directory", () => {
    turnOutput({ session_id: "../../evil" }, { interval: 5, dir });

    expect(fs.readdirSync(dir)).toEqual([".._.._evil.json"]);
  });

  it("recovers from a corrupt counter file", () => {
    fs.writeFileSync(path.join(dir, "s1.json"), "{garbage");

    expect(turnOutput({ session_id: "s1" }, { interval: 1, dir })).not.toBeNull();
  });

  it("prunes counters untouched for a week", () => {
    const old = path.join(dir, "old.json");
    fs.writeFileSync(old, '{"count":3}');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

    turnOutput({ session_id: "new" }, { interval: 5, dir });

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(dir, "new.json"))).toBe(true);
  });
});

describe("stateDir", () => {
  it("prefers plugin data, then XDG_STATE_HOME, then ~/.local/state", () => {
    expect(stateDir({ CLAUDE_PLUGIN_DATA: "/p", XDG_STATE_HOME: "/x" })).toBe("/p/turn-state");
    expect(stateDir({ XDG_STATE_HOME: "/x" })).toBe("/x/agent-memory/turn-state");
    expect(stateDir({ HOME: "/home/me" })).toBe("/home/me/.local/state/agent-memory/turn-state");
  });
});

describe("agent-memory hook", () => {
  const originalEnv = { ...process.env };
  let out: string[];
  let err: string[];

  function io(stdin: string | null): CliIO {
    return {
      cwd: dir,
      home: dir,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: async () => stdin,
      readFile: () => "",
      readSecret: async () => "",
    };
  }

  beforeEach(() => {
    out = [];
    err = [];
    process.env = { ...originalEnv, XDG_STATE_HOME: dir };
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.MEMORY_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("session-start prints hook JSON without needing an API key", async () => {
    expect(await run(["hook", "session-start"], io('{"source":"compact"}'))).toBe(EXIT.ok);

    const parsed = JSON.parse(out[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("recursive-task-state");
  });

  it("turn honours --interval", async () => {
    const input = '{"session_id":"s1","prompt":"hi"}';
    await run(["hook", "turn", "--interval", "2"], io(input));
    expect(out).toEqual([]);
    await run(["hook", "turn", "--interval", "2"], io(input));
    expect(JSON.parse(out[0]).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("exits 0 even for an unknown event or bad interval, logging to stderr", async () => {
    expect(await run(["hook", "bogus"], io(null))).toBe(EXIT.ok);
    expect(await run(["hook", "turn", "--interval", "0"], io("{}"))).toBe(EXIT.ok);
    expect(await run(["hook"], io(null))).toBe(EXIT.ok);
    expect(out).toEqual([]);
    expect(err).toHaveLength(3);
  });
});

describe("CLI plugin hooks.json", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../plugins/agent-memory-cli/hooks/hooks.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));

  it("registers only SessionStart, calling the CLI on PATH with a fallback", () => {
    expect(Object.keys(config.hooks)).toEqual(["SessionStart"]);
    const hook = config.hooks.SessionStart[0].hooks[0];
    expect(hook.command).toMatch(/^agent-memory hook session-start \|\| echo /);
    expect(hook.timeout).toBeLessThanOrEqual(30);
  });

  it("does not reach outside the plugin directory", () => {
    expect(JSON.stringify(config)).not.toMatch(/CLAUDE_PLUGIN_ROOT|\.\.\/|dist\//);
  });
});
