import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Code permission rules that let agents use memory without a prompt.
 * `delete` and `init` are left out on purpose: deleting shared memory and editing
 * settings should still ask.
 */
export const ALLOWLIST_RULES = [
  "Bash(agent-memory search:*)",
  "Bash(agent-memory load:*)",
  "Bash(agent-memory recent:*)",
  "Bash(agent-memory store:*)",
  "Bash(agent-memory update:*)",
  "Bash(agent-memory config)",
  "Bash(agent-memory health)",
] as const;

export type SettingsScope = "user" | "project";

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function settingsPath(
  scope: SettingsScope,
  options: { home?: string; cwd?: string } = {},
): string {
  return scope === "user"
    ? path.join(options.home ?? os.homedir(), ".claude", "settings.json")
    : path.join(options.cwd ?? process.cwd(), ".claude", "settings.json");
}

export interface AllowlistResult {
  file: string;
  changed: string[];
  backup?: string;
}

type Settings = Record<string, unknown> & {
  permissions?: Record<string, unknown> & { allow?: unknown };
};

function manualHint(rules: readonly string[]): string {
  return `Add these to permissions.allow by hand:\n${rules.map((r) => `  "${r}"`).join(",\n")}`;
}

function readSettings(file: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsError(
      `${file} is not valid JSON, so it was left untouched. ${manualHint(ALLOWLIST_RULES)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SettingsError(
      `${file} is not a JSON object, so it was left untouched. ${manualHint(ALLOWLIST_RULES)}`,
    );
  }
  const settings = parsed as Settings;
  const permissions = settings.permissions;
  if (
    permissions !== undefined &&
    (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))
  ) {
    throw new SettingsError(
      `${file} has a permissions value that is not an object, so it was left untouched. ${manualHint(ALLOWLIST_RULES)}`,
    );
  }
  if (permissions?.allow !== undefined && !Array.isArray(permissions.allow)) {
    throw new SettingsError(
      `${file} has a permissions.allow that is not an array, so it was left untouched. ${manualHint(ALLOWLIST_RULES)}`,
    );
  }
  return settings;
}

/**
 * Back up the current file, then replace it via temp file and rename. A symlinked
 * settings file (dotfiles repos) is written through to its target, so the link survives.
 */
function writeSettings(file: string, settings: Settings, now: Date): string | undefined {
  const exists = fs.existsSync(file);
  const target = exists ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let backup: string | undefined;
  let mode = 0o644;
  if (exists) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(target, backup);
    mode = fs.statSync(target).mode & 0o777;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return backup;
}

/** Add any missing rules to permissions.allow. Writes nothing when all rules are present. */
export function addAllowlist(file: string, now = new Date()): AllowlistResult {
  const settings = readSettings(file);
  const allow = (settings.permissions?.allow as unknown[] | undefined) ?? [];
  const missing = ALLOWLIST_RULES.filter((r) => !allow.includes(r));
  if (missing.length === 0) return { file, changed: [] };

  settings.permissions = {
    ...(settings.permissions ?? {}),
    allow: [...allow, ...missing],
  };
  const backup = writeSettings(file, settings, now);
  return { file, changed: missing, backup };
}

/** Remove the rules addAllowlist adds. Leaves every other rule alone. */
export function removeAllowlist(file: string, now = new Date()): AllowlistResult {
  const settings = readSettings(file);
  const allow = settings.permissions?.allow as unknown[] | undefined;
  if (!allow) return { file, changed: [] };

  const ours = new Set<unknown>(ALLOWLIST_RULES);
  const present = allow.filter((r) => ours.has(r)) as string[];
  if (present.length === 0) return { file, changed: [] };

  settings.permissions = {
    ...settings.permissions,
    allow: allow.filter((r) => !ours.has(r)),
  };
  const backup = writeSettings(file, settings, now);
  return { file, changed: present, backup };
}
