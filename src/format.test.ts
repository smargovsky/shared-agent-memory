import { describe, expect, it } from "vitest";
import {
  formatAttribution,
  formatConfig,
  formatLoadedMemories,
  formatMeta,
  formatRecent,
  formatSearchResults,
} from "./format.js";
import type { SearchResult } from "./types.js";

function memory(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "mem-1",
    score: 0.91234,
    text: "Full memory text",
    title: "Memory One",
    agent: "claude-code",
    project: "project-a",
    tags: ["tag-a", "tag-b"],
    created_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatAttribution", () => {
  it("is empty when no actor is known", () => {
    expect(formatAttribution(memory())).toBe("");
  });

  it("names a single actor", () => {
    expect(formatAttribution(memory({ createdBy: "alice" }))).toBe("by alice");
    expect(formatAttribution(memory({ updatedBy: "bob" }))).toBe("by bob");
  });

  it("names both actors when they differ", () => {
    expect(
      formatAttribution(memory({ createdBy: "alice", updatedBy: "bob" })),
    ).toBe("created by alice, updated by bob");
  });
});

describe("formatMeta", () => {
  it("shows only creation for an unchanged memory", () => {
    expect(formatMeta(memory({ createdBy: "alice" }))).toBe(
      "Created: 2026-05-01T00:00:00.000Z by alice",
    );
  });

  it("adds the update when the memory changed", () => {
    expect(
      formatMeta(
        memory({
          createdBy: "alice",
          updatedBy: "bob",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    ).toBe(
      "Created: 2026-05-01T00:00:00.000Z by alice | Updated: 2026-06-01T00:00:00.000Z by bob",
    );
  });
});

describe("formatSearchResults", () => {
  it("says so when nothing matched", () => {
    expect(formatSearchResults([])).toBe("No memories found.");
  });

  it("lists score, project, id, and title without full text", () => {
    const out = formatSearchResults([
      memory({ createdBy: "alice" }),
      memory({ id: "mem-2", title: "", score: 0.5 }),
    ]);

    expect(out).toBe(
      "[1] (score: 0.912) [project-a] mem-1\nMemory One — by alice\n" +
        "[2] (score: 0.500) [project-a] mem-2\n(untitled)",
    );
    expect(out).not.toContain("Full memory text");
  });
});

describe("formatLoadedMemories", () => {
  it("says so when no ids matched", () => {
    expect(formatLoadedMemories([])).toBe(
      "No memories found for the given IDs.",
    );
  });

  it("includes full text, tags, and metadata", () => {
    expect(formatLoadedMemories([memory()])).toBe(
      "[1] [claude-code/project-a]\nID: mem-1\nTitle: Memory One\nFull memory text\n" +
        "Tags: tag-a, tag-b | Created: 2026-05-01T00:00:00.000Z",
    );
  });

  it("separates memories with a blank line and handles missing tags", () => {
    const out = formatLoadedMemories([
      memory(),
      memory({ id: "mem-2", tags: undefined as unknown as string[] }),
    ]);

    expect(out.split("\n\n")).toHaveLength(2);
    expect(out).toContain("Tags: none |");
  });
});

describe("formatRecent", () => {
  it("says so when there is nothing recent", () => {
    expect(formatRecent([])).toBe("No recent memories.");
  });

  it("lists project, id, creation time, and title", () => {
    expect(formatRecent([memory({ updatedBy: "bob" })])).toBe(
      "[1] [project-a] mem-1 2026-05-01T00:00:00.000Z\nMemory One — by bob",
    );
  });
});

describe("formatConfig", () => {
  it("shows API, collection, defaults, and model status", () => {
    expect(
      formatConfig(
        {
          apiBaseUrl: "http://memory.example.test",
          collectionName: "shared_agent_memory",
          modelReady: true,
        },
        { agent: "claude-code", project: "project-a" },
      ),
    ).toBe(
      "Memory API: http://memory.example.test\nCollection: shared_agent_memory\n" +
        "Default Agent: claude-code\nDefault Project: project-a\nModel Ready: true",
    );
  });
});
