import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWLIST_RULES } from "./allowlist.js";
import { configPath, readConfigFile } from "./config.js";
import { CliIO, EXIT, run } from "./run.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const originalEnv = { ...process.env };
let dir: string;
let calls: FetchCall[];
let respond: (url: string, init?: RequestInit) => Response;
let out: string[];
let err: string[];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeIO(options: { stdin?: string | null; secret?: string } = {}): CliIO {
  return {
    cwd: path.join(dir, "work", "my-repo"),
    home: dir,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: async (max) =>
      options.stdin === undefined || options.stdin === null
        ? null
        : options.stdin.slice(0, max + 1),
    readFile: (f, max) => fs.readFileSync(f, "utf8").slice(0, max + 1),
    readSecret: async () => options.secret ?? "",
  };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(calls[calls.length - 1].init?.body));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-run-"));
  calls = [];
  out = [];
  err = [];
  process.env = {
    ...originalEnv,
    XDG_CONFIG_HOME: path.join(dir, "xdg"),
    MEMORY_API_URL: "https://memory.example.test",
    MEMORY_API_KEY: "test-key",
    MEMORY_API_TIMEOUT_MS: "50",
    DEFAULT_PROJECT: "",
    DEFAULT_AGENT: "",
  };
  delete process.env.MEMORY_MAX_TEXT_BYTES;
  respond = (url, init) => {
    if (url.includes("/search")) {
      return jsonResponse({
        data: [{ id: "mem-1", title: "One", project: "p", score: 0.5 }],
      });
    }
    if (url.includes("/load")) {
      return jsonResponse({
        data: [
          {
            id: "mem-1",
            title: "One",
            text: "Body",
            agent: "a",
            project: "p",
            tags: [],
            created_at: "2026-01-01",
          },
        ],
      });
    }
    if (url.includes("/recent")) return jsonResponse({ data: [] });
    if (url.endsWith("/api/v1/config")) {
      return jsonResponse({ data: { collectionName: "c", modelReady: true } });
    }
    if (url.endsWith("/health")) return jsonResponse({ modelReady: true });
    if (init?.method === "POST") return jsonResponse({ data: { id: "new-id" } }, 201);
    return jsonResponse({ data: { success: true } });
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return respond(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("help and usage", () => {
  it("prints usage and exits 2 with no command", async () => {
    expect(await run([], makeIO())).toBe(EXIT.usage);
    expect(out[0]).toContain("agent-memory search");
  });

  it("exits 0 for help", async () => {
    expect(await run(["help"], makeIO())).toBe(EXIT.ok);
  });

  it("exits 2 for an unknown command or flag", async () => {
    expect(await run(["frobnicate"], makeIO())).toBe(EXIT.usage);
    expect(await run(["search", "q", "--bogus"], makeIO())).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });

  it("does not accept an API key flag", async () => {
    expect(await run(["search", "q", "--api-key", "x"], makeIO())).toBe(EXIT.usage);
  });
});

describe("read commands", () => {
  it("search joins words into one query and prints compact results", async () => {
    const code = await run(
      ["search", "docker", "compose", "--limit", "5", "--tags", "a, b", "--project", "p"],
      makeIO(),
    );

    expect(code).toBe(EXIT.ok);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("query")).toBe("docker compose");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("tags")).toBe("a,b");
    expect(url.searchParams.get("project")).toBe("p");
    expect(out[0]).toContain("[1] (score: 0.500) [p] mem-1");
  });

  it("search --json prints raw results", async () => {
    await run(["search", "q", "--json"], makeIO());

    expect(JSON.parse(out[0])).toEqual([
      { id: "mem-1", title: "One", project: "p", score: 0.5 },
    ]);
  });

  it("rejects an out-of-range limit before calling the API", async () => {
    expect(await run(["search", "q", "--limit", "0"], makeIO())).toBe(EXIT.usage);
    expect(await run(["search", "q", "--limit", "1000"], makeIO())).toBe(EXIT.usage);
    expect(calls).toHaveLength(0);
  });

  it("search needs a query", async () => {
    expect(await run(["search"], makeIO())).toBe(EXIT.usage);
  });

  it("load accepts space- and comma-separated ids", async () => {
    await run(["load", "a", "b,c"], makeIO());

    expect(new URL(calls[0].url).searchParams.get("ids")).toBe("a,b,c");
    expect(out[0]).toContain("Title: One");
  });

  it("load caps the number of ids", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    expect(await run(["load", ...ids], makeIO())).toBe(EXIT.usage);
  });

  it("recent defaults to 10 results over 30 days", async () => {
    await run(["recent"], makeIO());

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("days")).toBe("30");
    expect(out[0]).toBe("No recent memories.");
  });
});

describe("store", () => {
  it("reads text from stdin, drops the heredoc newline, and resolves the project", async () => {
    process.env.DEFAULT_PROJECT = "team-project";
    const code = await run(
      ["store", "--title", "Deploy steps", "--tags", "deploy,ops"],
      makeIO({ stdin: "Line one\nLine 'two' with `ticks`\n" }),
    );

    expect(code).toBe(EXIT.ok);
    expect(lastBody()).toEqual({
      title: "Deploy steps",
      text: "Line one\nLine 'two' with `ticks`",
      project: "team-project",
      agent: "claude-code",
      tags: ["deploy", "ops"],
    });
    expect(out[0]).toBe("Memory stored with ID: new-id (project: team-project)");
  });

  it("reads text from --text-file", async () => {
    const f = path.join(dir, "memory.md");
    fs.writeFileSync(f, "From a file\n");

    await run(["store", "--title", "T", "--project", "p", "--text-file", f], makeIO());

    expect(lastBody().text).toBe("From a file");
  });

  it("uses the agent from the config file when no flag or env is set", async () => {
    delete process.env.MEMORY_API_KEY;
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ apiUrl: "https://memory.example.test", apiKey: "k", agent: "serge-cc" }),
      { mode: 0o600 },
    );

    await run(["store", "--title", "T", "--project", "p"], makeIO({ stdin: "x" }));

    expect(lastBody().agent).toBe("serge-cc");
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("refuses text passed as an argument", async () => {
    expect(await run(["store", "--title", "T", "some text"], makeIO({ stdin: "x" }))).toBe(
      EXIT.usage,
    );
    expect(calls).toHaveLength(0);
  });

  it("needs a title, a body, and nothing too big", async () => {
    expect(await run(["store"], makeIO({ stdin: "x" }))).toBe(EXIT.usage);
    expect(await run(["store", "--title", "T"], makeIO({ stdin: null }))).toBe(EXIT.usage);
    expect(await run(["store", "--title", "T"], makeIO({ stdin: "  \n" }))).toBe(EXIT.usage);
    expect(
      await run(["store", "--title", "x".repeat(121)], makeIO({ stdin: "x" })),
    ).toBe(EXIT.usage);

    process.env.MEMORY_MAX_TEXT_BYTES = "10";
    expect(await run(["store", "--title", "T"], makeIO({ stdin: "x".repeat(11) }))).toBe(
      EXIT.usage,
    );
    expect(err.join("\n")).toContain("over 10 bytes");
    expect(calls).toHaveLength(0);
  });

  it("exits 4 when the secret filter rejects the text", async () => {
    respond = () =>
      jsonResponse(
        { error: { code: 400, message: "Secret detected in text (rule: aws, position: 0): AKIA***" } },
        400,
      );

    const code = await run(["store", "--title", "T", "--project", "p"], makeIO({ stdin: "x" }));

    expect(code).toBe(EXIT.secretRejected);
    expect(err.join("\n")).toContain("Redact the flagged value");
  });

  it("exits 3 on other API errors and says when the outcome is unknown", async () => {
    respond = () => {
      throw new TypeError("fetch failed");
    };

    const code = await run(["store", "--title", "T", "--project", "p"], makeIO({ stdin: "x" }));

    expect(code).toBe(EXIT.failure);
    expect(err.join("\n")).toContain("search before retrying");
  });
});

describe("update and delete", () => {
  it("update sends text from stdin and an optional title", async () => {
    const code = await run(["update", "mem-1", "--title", "New"], makeIO({ stdin: "Body\n" }));

    expect(code).toBe(EXIT.ok);
    expect(calls[0].url).toBe("https://memory.example.test/api/v1/memories/mem-1");
    expect(calls[0].init?.method).toBe("PUT");
    expect(lastBody()).toEqual({ text: "Body", title: "New" });
  });

  it("update and delete take exactly one id", async () => {
    expect(await run(["update"], makeIO({ stdin: "x" }))).toBe(EXIT.usage);
    expect(await run(["delete", "a", "b"], makeIO())).toBe(EXIT.usage);
  });

  it("delete calls DELETE", async () => {
    expect(await run(["delete", "mem-1"], makeIO())).toBe(EXIT.ok);
    expect(calls[0].init?.method).toBe("DELETE");
  });
});

describe("credentials and URL safety", () => {
  it("exits 3 with setup advice when there is no key", async () => {
    delete process.env.MEMORY_API_KEY;

    expect(await run(["search", "q"], makeIO())).toBe(EXIT.failure);
    expect(err.join("\n")).toContain("agent-memory init");
    expect(calls).toHaveLength(0);
  });

  it("refuses plain http to a remote host unless --insecure", async () => {
    process.env.MEMORY_API_URL = "http://memory.example.test";

    expect(await run(["search", "q"], makeIO())).toBe(EXIT.failure);
    expect(calls).toHaveLength(0);
    expect(await run(["search", "q", "--insecure"], makeIO())).toBe(EXIT.ok);
  });

  it("health works without a key", async () => {
    delete process.env.MEMORY_API_KEY;

    expect(await run(["health"], makeIO())).toBe(EXIT.ok);
    expect(out[0]).toContain("reachable");
  });

  it("config reports where credentials came from", async () => {
    await run(["config", "--json"], makeIO());

    expect(JSON.parse(out[0])).toMatchObject({
      apiBaseUrl: "https://memory.example.test",
      credentials: "env",
      defaults: { agent: "claude-code" },
    });
  });
});

describe("init", () => {
  it("prompts for the key and writes a 600 config", async () => {
    const code = await run(
      ["init", "--api-url", "https://memory.example.test/", "--agent", "me"],
      makeIO({ secret: "  secret-key \n" }),
    );

    expect(code).toBe(EXIT.ok);
    expect(readConfigFile(configPath())).toEqual({
      apiUrl: "https://memory.example.test",
      apiKey: "secret-key",
      agent: "me",
    });
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).not.toContain("secret-key");
  });

  it("keeps an existing config and only prompts when rotating", async () => {
    await run(["init"], makeIO({ secret: "first" }));
    await run(["init"], makeIO({ secret: "ignored" }));
    expect(readConfigFile(configPath())?.apiKey).toBe("first");

    await run(["init", "--rotate-key"], makeIO({ secret: "second" }));
    expect(readConfigFile(configPath())?.apiKey).toBe("second");
  });

  it("refuses an empty key or insecure URL", async () => {
    expect(await run(["init"], makeIO({ secret: "" }))).toBe(EXIT.usage);
    expect(
      await run(["init", "--api-url", "http://memory.example.test"], makeIO({ secret: "k" })),
    ).toBe(EXIT.failure);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it("--allowlist adds the rules to user settings, and --remove-allowlist takes them out", async () => {
    const settings = path.join(dir, ".claude", "settings.json");

    expect(await run(["init", "--allowlist"], makeIO({ secret: "k" }))).toBe(EXIT.ok);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow).toEqual([
      ...ALLOWLIST_RULES,
    ]);

    expect(await run(["init", "--remove-allowlist"], makeIO())).toBe(EXIT.ok);
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.allow).toEqual([]);
  });

  it("--scope project writes the repo's .claude/settings.json", async () => {
    await run(["init", "--allowlist", "--scope", "project"], makeIO({ secret: "k" }));

    expect(
      fs.existsSync(path.join(dir, "work", "my-repo", ".claude", "settings.json")),
    ).toBe(true);
  });

  it("rejects a bad scope and conflicting flags", async () => {
    expect(await run(["init", "--scope", "global"], makeIO())).toBe(EXIT.usage);
    expect(await run(["init", "--allowlist", "--remove-allowlist"], makeIO())).toBe(
      EXIT.usage,
    );
  });
});
