import arg from "arg";
import * as client from "../client.js";
import { MemoryApiError } from "../client.js";
import {
  formatConfig,
  formatLoadedMemories,
  formatRecent,
  formatSearchResults,
} from "../format.js";
import { resolveDefaultProject } from "../project.js";
import { SearchResult } from "../types.js";
import {
  addAllowlist,
  removeAllowlist,
  SettingsError,
  SettingsScope,
  settingsPath,
} from "./allowlist.js";
import {
  DEFAULT_TURN_INTERVAL,
  HookOutput,
  parseHookInput,
  sessionStartOutput,
  stateDir,
  turnOutput,
} from "./hooks.js";
import {
  applyConfig,
  assertSecureUrl,
  ConfigError,
  configPath,
  readConfigFile,
  writeConfigFile,
} from "./config.js";

export const EXIT = {
  ok: 0,
  usage: 2,
  failure: 3,
  secretRejected: 4,
} as const;

const DEFAULT_MAX_TEXT_BYTES = 8192;
const MAX_TITLE_CHARS = 120;
const MAX_LOAD_IDS = 50;
const MAX_LIMIT = 100;
const DEFAULT_AGENT = "claude-code";
// UserPromptSubmit input carries the whole prompt; the fields hooks need are small.
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

/** Everything the CLI touches outside itself, so tests can drive it. API settings come from process.env. */
export interface CliIO {
  cwd: string;
  home: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Body text piped on stdin, or null when stdin is a terminal. Reads at most maxBytes + 1. */
  readStdin: (maxBytes: number) => Promise<string | null>;
  /** Read a file, at most maxBytes + 1 bytes. */
  readFile: (file: string, maxBytes: number) => string;
  /** API key: hidden prompt on a terminal, or the first line of piped stdin. */
  readSecret: (prompt: string) => Promise<string>;
}

class UsageError extends Error {}

const USAGE = `agent-memory — shared agent memory from the command line

Read:
  agent-memory search <query...> [--limit N] [--project P] [--tags a,b] [--agent A]
  agent-memory load <id...>
  agent-memory recent [--limit N] [--days D] [--project P]

Write (memory text on stdin, or --text-file):
  agent-memory store --title "Short title" [--tags a,b] [--project P] <<'EOF'
  ...memory text...
  EOF
  agent-memory update <id> [--title T] <<'EOF' ... EOF
  agent-memory delete <id>

Setup:
  agent-memory init [--api-url URL] [--agent NAME] [--rotate-key] [--allowlist] [--scope user|project]
  agent-memory init --remove-allowlist [--scope user|project]
  agent-memory config
  agent-memory health

Claude Code hooks (always exit 0, read hook JSON on stdin):
  agent-memory hook session-start          guidance; adds a resume prompt after compaction
  agent-memory hook turn [--interval N]    opt-in nudge to store learnings every Nth prompt (default 5)

Every command takes --json for machine-readable output and --insecure to allow
plain http to a non-local host. The API key comes from MEMORY_API_KEY or the
config file written by init, never from a flag.

Exit codes: 0 ok, 2 usage, 3 API/config failure, 4 rejected by the secret filter.`;

const COMMON = { "--json": Boolean, "--insecure": Boolean } as const;

function parseArgs<T extends arg.Spec>(spec: T, argv: string[]): arg.Result<T> {
  try {
    return arg(spec, { argv });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function positiveInt(
  name: string,
  value: number | undefined,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UsageError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function maxTextBytes(): number {
  const raw = Number(process.env.MEMORY_MAX_TEXT_BYTES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_TEXT_BYTES;
}

/** Memory text from --text-file or stdin, size-checked. Trailing whitespace (heredoc newline) is dropped. */
async function readBody(io: CliIO, textFile: string | undefined): Promise<string> {
  const max = maxTextBytes();
  let text: string | null;
  if (textFile) {
    text = io.readFile(textFile, max);
  } else {
    text = await io.readStdin(max);
    if (text === null) {
      throw new UsageError(
        "Memory text goes on stdin (heredoc) or --text-file; nothing was piped.",
      );
    }
  }
  if (Buffer.byteLength(text, "utf8") > max) {
    throw new UsageError(
      `Memory text is over ${max} bytes. Split it into smaller memories, one concept each.`,
    );
  }
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) throw new UsageError("Memory text is empty.");
  return trimmed;
}

function checkTitle(title: string | undefined, required: boolean): string | undefined {
  if (title === undefined) {
    if (required) throw new UsageError("--title is required");
    return undefined;
  }
  const t = title.trim();
  if (!t) throw new UsageError("--title must not be empty");
  if (t.length > MAX_TITLE_CHARS) {
    throw new UsageError(`--title is over ${MAX_TITLE_CHARS} characters`);
  }
  return t;
}

function one(ids: string[], what: string): string {
  if (ids.length !== 1) throw new UsageError(`${what} takes exactly one memory id`);
  return ids[0];
}

function print(io: CliIO, json: boolean, data: unknown, text: string): void {
  io.stdout(json ? JSON.stringify(data, null, 2) : text);
}

async function runApiCommand(
  command: string,
  rest: string[],
  io: CliIO,
): Promise<number> {
  switch (command) {
    case "search": {
      const a = parseArgs(
        {
          ...COMMON,
          "--limit": Number,
          "--project": String,
          "--tags": String,
          "--agent": String,
        },
        rest,
      );
      const query = a._.join(" ").trim();
      if (!query) throw new UsageError("search needs a query");
      const limit = positiveInt("--limit", a["--limit"], MAX_LIMIT);
      applyConfig({ env: process.env, insecure: Boolean(a["--insecure"]) });
      const result = await client.searchMemory({
        query,
        limit,
        project: a["--project"],
        agent: a["--agent"],
        tags: splitList(a["--tags"]),
      });
      const results = result.results as SearchResult[];
      print(io, Boolean(a["--json"]), results, formatSearchResults(results));
      return EXIT.ok;
    }

    case "load": {
      const a = parseArgs(COMMON, rest);
      const ids = a._.flatMap((s) => splitList(s) ?? []);
      if (ids.length === 0) throw new UsageError("load needs at least one memory id");
      if (ids.length > MAX_LOAD_IDS) {
        throw new UsageError(`load takes at most ${MAX_LOAD_IDS} ids at once`);
      }
      applyConfig({ env: process.env, insecure: Boolean(a["--insecure"]) });
      const result = await client.loadMemories(ids);
      const results = result.results as SearchResult[];
      print(io, Boolean(a["--json"]), results, formatLoadedMemories(results));
      return EXIT.ok;
    }

    case "recent": {
      const a = parseArgs(
        { ...COMMON, "--limit": Number, "--days": Number, "--project": String },
        rest,
      );
      const limit = positiveInt("--limit", a["--limit"], MAX_LIMIT) ?? 10;
      const days = positiveInt("--days", a["--days"], 3650) ?? 30;
      applyConfig({ env: process.env, insecure: Boolean(a["--insecure"]) });
      const result = await client.listRecent({
        limit,
        days,
        project: a["--project"],
      });
      const results = result.results as SearchResult[];
      print(io, Boolean(a["--json"]), results, formatRecent(results));
      return EXIT.ok;
    }

    case "store": {
      const a = parseArgs(
        {
          ...COMMON,
          "--title": String,
          "--tags": String,
          "--project": String,
          "--agent": String,
          "--text-file": String,
        },
        rest,
      );
      if (a._.length > 0) {
        throw new UsageError(
          "store takes the memory text on stdin or --text-file, not as an argument",
        );
      }
      const title = checkTitle(a["--title"], true) as string;
      const text = await readBody(io, a["--text-file"]);
      const { agent: configAgent } = applyConfig({
        env: process.env,
        insecure: Boolean(a["--insecure"]),
      });
      const project = resolveDefaultProject({
        flag: a["--project"],
        cwd: io.cwd,
      });
      const agent =
        a["--agent"] || process.env.DEFAULT_AGENT || configAgent || DEFAULT_AGENT;
      const result = await client.storeMemory({
        title,
        text,
        project,
        agent,
        tags: splitList(a["--tags"]),
      });
      print(
        io,
        Boolean(a["--json"]),
        { id: result.id, project },
        `Memory stored with ID: ${result.id} (project: ${project})`,
      );
      return EXIT.ok;
    }

    case "update": {
      const a = parseArgs(
        { ...COMMON, "--title": String, "--text-file": String },
        rest,
      );
      const id = one(a._, "update");
      const title = checkTitle(a["--title"], false);
      const text = await readBody(io, a["--text-file"]);
      applyConfig({ env: process.env, insecure: Boolean(a["--insecure"]) });
      await client.updateMemory({ id, text, title });
      print(io, Boolean(a["--json"]), { id, updated: true }, `Memory ${id} updated.`);
      return EXIT.ok;
    }

    case "delete": {
      const a = parseArgs(COMMON, rest);
      const id = one(a._, "delete");
      applyConfig({ env: process.env, insecure: Boolean(a["--insecure"]) });
      await client.deleteMemory(id);
      print(io, Boolean(a["--json"]), { id, deleted: true }, `Memory ${id} deleted.`);
      return EXIT.ok;
    }

    case "config": {
      const a = parseArgs(COMMON, rest);
      const { agent: configAgent, source } = applyConfig({
        env: process.env,
        insecure: Boolean(a["--insecure"]),
      });
      const config = await client.getConfig();
      const defaults = {
        agent: process.env.DEFAULT_AGENT || configAgent || DEFAULT_AGENT,
        project: resolveDefaultProject({ cwd: io.cwd }),
      };
      print(
        io,
        Boolean(a["--json"]),
        { ...config, defaults, credentials: source, configFile: configPath() },
        `${formatConfig(config, defaults)}\nCredentials: ${source === "env" ? "environment" : configPath()}`,
      );
      return EXIT.ok;
    }

    case "health": {
      const a = parseArgs(COMMON, rest);
      const insecure = Boolean(a["--insecure"]);
      // /health needs no key, so this works before init.
      try {
        applyConfig({ env: process.env, insecure });
      } catch (err) {
        if (!(err instanceof ConfigError) || !/No API key/.test(err.message)) throw err;
        const url = process.env.MEMORY_API_BASE_URL || process.env.MEMORY_API_URL;
        if (url) assertSecureUrl(url, insecure);
      }
      const result = await client.ping();
      print(
        io,
        Boolean(a["--json"]),
        result,
        result.pong
          ? `Memory API reachable. Model ready: ${result.modelReady}`
          : "Memory API answered but is not healthy.",
      );
      return result.pong ? EXIT.ok : EXIT.failure;
    }

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

async function runInit(rest: string[], io: CliIO): Promise<number> {
  const a = parseArgs(
    {
      ...COMMON,
      "--api-url": String,
      "--agent": String,
      "--rotate-key": Boolean,
      "--allowlist": Boolean,
      "--remove-allowlist": Boolean,
      "--scope": String,
    },
    rest,
  );
  if (a._.length > 0) throw new UsageError("init takes no positional arguments");
  if (a["--allowlist"] && a["--remove-allowlist"]) {
    throw new UsageError("Pass --allowlist or --remove-allowlist, not both");
  }
  const scope = (a["--scope"] ?? "user") as SettingsScope;
  if (scope !== "user" && scope !== "project") {
    throw new UsageError("--scope must be user or project");
  }
  const settingsFile = settingsPath(scope, { home: io.home, cwd: io.cwd });
  const lines: string[] = [];

  if (a["--remove-allowlist"]) {
    const result = removeAllowlist(settingsFile);
    lines.push(
      result.changed.length > 0
        ? `Removed ${result.changed.length} agent-memory rules from ${result.file} (backup: ${result.backup})`
        : `No agent-memory rules in ${result.file}; nothing changed.`,
    );
    print(io, Boolean(a["--json"]), { allowlist: result }, lines.join("\n"));
    return EXIT.ok;
  }

  const file = configPath();
  const existing = readConfigFile(file);
  const needsWrite =
    !existing || Boolean(a["--api-url"] || a["--agent"] || a["--rotate-key"]);

  if (needsWrite) {
    const apiUrl = (a["--api-url"] ?? existing?.apiUrl ?? "http://localhost:3100").replace(
      /\/+$/,
      "",
    );
    assertSecureUrl(apiUrl, Boolean(a["--insecure"]));
    let apiKey = existing?.apiKey ?? "";
    if (!existing || a["--rotate-key"]) {
      apiKey = (await io.readSecret("Memory API key: ")).trim();
      if (!apiKey) throw new UsageError("No API key entered.");
    }
    writeConfigFile(file, {
      apiUrl,
      apiKey,
      agent: a["--agent"] ?? existing?.agent,
    });
    lines.push(`Saved ${file} (mode 600) for ${apiUrl}.`);
  } else {
    lines.push(`Kept existing ${file}. Pass --rotate-key or --api-url to change it.`);
  }

  let allowlist;
  if (a["--allowlist"]) {
    allowlist = addAllowlist(settingsFile);
    lines.push(
      allowlist.changed.length > 0
        ? `Added ${allowlist.changed.length} rules to ${allowlist.file} (backup: ${allowlist.backup ?? "none, file was new"}). delete still asks.`
        : `${allowlist.file} already allows agent-memory; nothing changed.`,
    );
  }
  lines.push("Check it with: agent-memory config");

  print(
    io,
    Boolean(a["--json"]),
    { configFile: file, saved: needsWrite, allowlist },
    lines.join("\n"),
  );
  return EXIT.ok;
}

/**
 * `agent-memory hook <event>` for Claude Code hooks. Always exits 0: exit 2 from a
 * UserPromptSubmit hook would block the user's prompt, and any other non-zero code shows
 * them an error. Problems go to stderr, which Claude Code keeps in its debug log.
 */
async function runHook(rest: string[], io: CliIO): Promise<number> {
  try {
    const a = parseArgs({ "--interval": Number }, rest);
    const [event] = a._;
    const input = parseHookInput(await io.readStdin(MAX_HOOK_INPUT_BYTES));

    let output: HookOutput | null;
    if (event === "session-start") {
      output = sessionStartOutput(input);
    } else if (event === "turn") {
      const interval =
        positiveInt("--interval", a["--interval"], MAX_LIMIT) ?? DEFAULT_TURN_INTERVAL;
      output = turnOutput(input, { interval, dir: stateDir() });
    } else {
      throw new UsageError(`Unknown hook event: ${event ?? "(none)"}. Use session-start or turn.`);
    }

    if (output) io.stdout(JSON.stringify(output));
  } catch (err) {
    io.stderr(`agent-memory hook: ${err instanceof Error ? err.message : String(err)}`);
  }
  return EXIT.ok;
}

/** Run one CLI invocation and return its exit code. Never throws. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }

  if (command === "hook") return runHook(rest, io);

  try {
    if (command === "init") return await runInit(rest, io);
    return await runApiCommand(command, rest, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`agent-memory: ${err.message}\nRun 'agent-memory help' for usage.`);
      return EXIT.usage;
    }
    if (err instanceof MemoryApiError) {
      io.stderr(`agent-memory: ${err.message}`);
      const secret =
        err.kind === "http" && err.status === 400 && /Secret detected/.test(err.message);
      if (secret) {
        io.stderr("Redact the flagged value and run the command again.");
        return EXIT.secretRejected;
      }
      return EXIT.failure;
    }
    if (err instanceof ConfigError || err instanceof SettingsError) {
      io.stderr(`agent-memory: ${err.message}`);
      return EXIT.failure;
    }
    io.stderr(`agent-memory: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.failure;
  }
}
