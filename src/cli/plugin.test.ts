import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

describe("agent-memory-cli plugin packaging", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const entry = marketplace.plugins.find((p: { name: string }) => p.name === "agent-memory-cli");
  const pluginDir = path.join(root, entry?.source ?? "missing");
  const manifest = readJson(path.join(entry?.source ?? "missing", ".claude-plugin/plugin.json"));

  it("is listed in the marketplace next to the MCP plugin", () => {
    expect(entry).toBeDefined();
    expect(marketplace.plugins.map((p: { name: string }) => p.name)).toContain(
      "shared-agent-memory",
    );
  });

  it("has a manifest whose name and version match the marketplace entry", () => {
    expect(manifest.name).toBe(entry.name);
    expect(manifest.version).toBe(entry.version);
  });

  it("ships no MCP server and no plugin settings", () => {
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("userConfig");
    expect(fs.existsSync(path.join(pluginDir, ".mcp.json"))).toBe(false);
  });

  it("contains the skill and hooks", () => {
    expect(fs.existsSync(path.join(pluginDir, "skills/shared-memory/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "hooks/hooks.json"))).toBe(true);
  });
});
