import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What `agent-memory init` saves. The API key lives only here or in the environment, never in argv. */
export interface CliConfig {
  apiUrl: string;
  apiKey: string;
  agent?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "shared-agent-memory", "config.json");
}

/**
 * Read the config file. Returns null when it does not exist. Refuses a file that other
 * users can read, since it holds a bearer token for shared team state.
 */
export function readConfigFile(file: string): CliConfig | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ConfigError(
      `${file} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${file}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(`${file} is not valid JSON. Re-run: agent-memory init`);
  }
  const c = parsed as Partial<CliConfig>;
  if (typeof c?.apiUrl !== "string" || typeof c?.apiKey !== "string") {
    throw new ConfigError(
      `${file} must contain string apiUrl and apiKey. Re-run: agent-memory init`,
    );
  }
  return {
    apiUrl: c.apiUrl,
    apiKey: c.apiKey,
    agent: typeof c.agent === "string" ? c.agent : undefined,
  };
}

/** Write the config with mode 0600 via a temp file and rename, so a crash never leaves half a file. */
export function writeConfigFile(file: string, config: CliConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Reject plain http to anything but this machine. The bearer token would cross the
 * network in the clear, and once the API is shared that token writes to team memory.
 */
export function assertSecureUrl(url: string, insecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol !== "http:") {
    throw new ConfigError(`Memory API URL must be http(s): ${url}`);
  }
  if (LOCAL_HOSTS.has(parsed.hostname) || insecure) return;
  throw new ConfigError(
    `Refusing plain http to ${parsed.hostname}: the API key would be sent unencrypted. Use https, or pass --insecure.`,
  );
}

/**
 * Settle the API URL and key for this run and put them in the environment, where
 * src/client.ts reads them. Environment variables win over the config file.
 */
export function applyConfig(options: {
  env: NodeJS.ProcessEnv;
  insecure: boolean;
}): { apiUrl: string; agent?: string; source: "env" | "file" } {
  const { env } = options;
  // Same variables and order as src/client.ts.
  const envUrl =
    env.MEMORY_API_BASE_URL || env.MEMORY_API_URL || env.SHARED_MEMORY_API_URL;
  const envKey =
    env.MEMORY_API_KEY ||
    env.SHARED_MEMORY_API_KEY ||
    env.SHARED_MEMORY_API_TOKEN;

  let source: "env" | "file" = "env";
  let agent: string | undefined;
  if (!envKey) {
    const file = configPath(env);
    const config = readConfigFile(file);
    if (!config) {
      throw new ConfigError(
        `No API key. Set MEMORY_API_KEY or run: agent-memory init`,
      );
    }
    env.MEMORY_API_KEY = config.apiKey;
    if (!envUrl) env.MEMORY_API_URL = config.apiUrl;
    agent = config.agent;
    source = "file";
  }

  const apiUrl =
    env.MEMORY_API_BASE_URL ||
    env.MEMORY_API_URL ||
    env.SHARED_MEMORY_API_URL ||
    "http://localhost:3100";
  assertSecureUrl(apiUrl, options.insecure);
  return { apiUrl, agent, source };
}
