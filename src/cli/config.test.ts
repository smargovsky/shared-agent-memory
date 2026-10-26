import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfig,
  assertSecureUrl,
  ConfigError,
  configPath,
  readConfigFile,
  writeConfigFile,
} from "./config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" })).toBe(
      "/xdg/shared-agent-memory/config.json",
    );
  });

  it("falls back to ~/.config", () => {
    expect(configPath({ HOME: "/home/me" })).toBe(
      "/home/me/.config/shared-agent-memory/config.json",
    );
  });
});

describe("config file", () => {
  it("round-trips and is written with mode 600", () => {
    const file = path.join(dir, "nested", "config.json");
    writeConfigFile(file, { apiUrl: "https://m.example", apiKey: "k", agent: "a" });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readConfigFile(file)).toEqual({
      apiUrl: "https://m.example",
      apiKey: "k",
      agent: "a",
    });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });

  it("returns null when the file does not exist", () => {
    expect(readConfigFile(path.join(dir, "missing.json"))).toBeNull();
  });

  it("refuses a file other users can read", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ apiUrl: "u", apiKey: "k" }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    expect(() => readConfigFile(file)).toThrow(/chmod 600/);
  });

  it("rejects invalid JSON and missing fields", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{not json", { mode: 0o600 });
    expect(() => readConfigFile(file)).toThrow(ConfigError);

    fs.writeFileSync(file, JSON.stringify({ apiUrl: "u" }), { mode: 0o600 });
    expect(() => readConfigFile(file)).toThrow(/apiUrl and apiKey/);
  });
});

describe("assertSecureUrl", () => {
  it.each([
    "https://memory.example.com",
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    "http://[::1]:3100",
  ])("allows %s", (url) => {
    expect(() => assertSecureUrl(url, false)).not.toThrow();
  });

  it("refuses plain http to a remote host unless insecure", () => {
    expect(() => assertSecureUrl("http://memory.example.com", false)).toThrow(
      /unencrypted/,
    );
    expect(() => assertSecureUrl("http://memory.example.com", true)).not.toThrow();
  });

  it("refuses other schemes and garbage", () => {
    expect(() => assertSecureUrl("ftp://memory.example.com", true)).toThrow(/http\(s\)/);
    expect(() => assertSecureUrl("not a url", false)).toThrow(/Not a valid URL/);
  });
});

describe("applyConfig", () => {
  function envWithConfig(config: object | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
    if (config) writeConfigFile(configPath(env), config as never);
    return env;
  }

  it("prefers environment variables over the config file", () => {
    const env = envWithConfig({ apiUrl: "https://file.example", apiKey: "file-key" });
    env.MEMORY_API_KEY = "env-key";
    env.MEMORY_API_URL = "https://env.example";

    const result = applyConfig({ env, insecure: false });

    expect(result).toMatchObject({ apiUrl: "https://env.example", source: "env" });
    expect(env.MEMORY_API_KEY).toBe("env-key");
  });

  it("loads key, URL, and agent from the config file", () => {
    const env = envWithConfig({
      apiUrl: "https://file.example",
      apiKey: "file-key",
      agent: "my-agent",
    });

    const result = applyConfig({ env, insecure: false });

    expect(result).toEqual({
      apiUrl: "https://file.example",
      agent: "my-agent",
      source: "file",
    });
    expect(env.MEMORY_API_KEY).toBe("file-key");
    expect(env.MEMORY_API_URL).toBe("https://file.example");
  });

  it("keeps an env URL when the key comes from the file", () => {
    const env = envWithConfig({ apiUrl: "https://file.example", apiKey: "file-key" });
    env.MEMORY_API_URL = "https://env.example";

    expect(applyConfig({ env, insecure: false }).apiUrl).toBe("https://env.example");
  });

  it("explains how to set up when there is no key anywhere", () => {
    expect(() => applyConfig({ env: envWithConfig(null), insecure: false })).toThrow(
      /agent-memory init/,
    );
  });

  it("refuses an insecure remote URL from the config file", () => {
    const env = envWithConfig({ apiUrl: "http://memory.example.com", apiKey: "k" });

    expect(() => applyConfig({ env, insecure: false })).toThrow(/unencrypted/);
  });
});
