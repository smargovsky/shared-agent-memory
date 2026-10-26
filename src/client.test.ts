import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteMemory,
  getConfig,
  loadMemories,
  MemoryApiError,
  ping,
  searchMemory,
  storeMemory,
  updateMemory,
} from "./client.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const originalEnv = { ...process.env };
let calls: FetchCall[];

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  process.env = {
    ...originalEnv,
    MEMORY_API_URL: "http://memory.example.test/",
    MEMORY_API_KEY: "test-api-key",
  };

  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });

      if (url.endsWith("/api/v1/config")) {
        return jsonResponse({
          data: { collectionName: "shared_agent_memory", modelReady: true },
        });
      }

      if (url.includes("/api/v1/memories/search")) {
        return jsonResponse({
          data: [
            {
              id: "mem-1",
              title: "Memory One",
              project: "project-a",
              score: 0.9,
            },
          ],
        });
      }

      if (url.includes("/api/v1/memories/load")) {
        return jsonResponse({
          data: [
            {
              id: "mem-1",
              title: "Memory One",
              project: "project-a",
              score: 1,
            },
          ],
        });
      }

      if (url.includes("/api/v1/memories/recent")) {
        return jsonResponse({
          data: [
            {
              id: "mem-1",
              title: "Memory One",
              project: "project-a",
              created_at: "2026-05-01T00:00:00.000Z",
            },
          ],
        });
      }

      if (init?.method === "POST") {
        return jsonResponse({ data: { id: "stored-id" } }, { status: 201 });
      }

      if (init?.method === "PUT" || init?.method === "DELETE") {
        return jsonResponse({ data: { success: true } });
      }

      return jsonResponse(
        { error: { message: "unexpected request" } },
        { status: 500 },
      );
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

describe("memory API client", () => {
  it("stores memories through the REST API with caller-provided project", async () => {
    const result = await storeMemory({
      title: "Stored",
      text: "Stored text",
      agent: "codex",
      project: "current-project",
      tags: ["tag-a"],
    });

    expect(result.id).toBe("stored-id");
    expect(calls[0].url).toBe("http://memory.example.test/api/v1/memories");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      title: "Stored",
      text: "Stored text",
      agent: "codex",
      project: "current-project",
      tags: ["tag-a"],
    });
  });

  it("omits project from search query when no filter is provided", async () => {
    const result = await searchMemory({ query: "needle", limit: 5 });

    expect(result.results).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/memories/search");
    expect(url.searchParams.get("query")).toBe("needle");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("project")).toBe(false);
  });

  it("passes project filter through when search specifies one", async () => {
    await searchMemory({
      query: "needle",
      project: "project-a",
      tags: ["one", "two"],
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("project")).toBe("project-a");
    expect(url.searchParams.get("tags")).toBe("one,two");
  });

  it("loads memories without sending a project query", async () => {
    await loadMemories(["mem-1", "mem-2"]);

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/memories/load");
    expect(url.searchParams.get("ids")).toBe("mem-1,mem-2");
    expect(url.searchParams.has("project")).toBe(false);
  });

  it("updates memories by id without changing project", async () => {
    await updateMemory({ id: "mem-1", title: "Updated", text: "Updated text" });

    expect(calls[0].url).toBe(
      "http://memory.example.test/api/v1/memories/mem-1",
    );
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      title: "Updated",
      text: "Updated text",
    });
  });

  it("deletes memories by id through the REST API", async () => {
    await deleteMemory("mem-1");

    expect(calls[0].url).toBe(
      "http://memory.example.test/api/v1/memories/mem-1",
    );
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
    });
    expect(calls[0].init?.headers).not.toHaveProperty("Content-Type");
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("reports API config with resolved API base URL", async () => {
    const config = await getConfig();

    expect(config.apiBaseUrl).toBe("http://memory.example.test");
    expect(config.collectionName).toBe("shared_agent_memory");
    expect(config).not.toHaveProperty("qdrantUrl");
  });
});

describe("memory API client failure handling", () => {
  type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

  function stubFetch(impl: FetchImpl): void {
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, init });
        return impl(url, init);
      },
    );
  }

  /** A fetch that never answers and rejects only when its abort signal fires. */
  function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init?.signal?.reason),
      );
    });
  }

  async function captureError(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected promise to reject");
  }

  beforeEach(() => {
    process.env.MEMORY_API_TIMEOUT_MS = "20";
  });

  it("passes an abort signal to every request", async () => {
    await searchMemory({ query: "needle" });

    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("times out a hung read and retries it once", async () => {
    stubFetch(hangingFetch);

    const err = await captureError(searchMemory({ query: "needle" }));

    expect(err).toBeInstanceOf(MemoryApiError);
    expect((err as MemoryApiError).kind).toBe("timeout");
    expect((err as MemoryApiError).outcomeUnknown).toBe(false);
    expect((err as MemoryApiError).message).toContain("timed out after 20ms");
    expect(calls).toHaveLength(2);
  });

  it("retries a read once after a 5xx and returns the second answer", async () => {
    let n = 0;
    stubFetch(async () =>
      ++n === 1
        ? jsonResponse({ error: { message: "boom" } }, { status: 503 })
        : jsonResponse({ data: [{ id: "mem-1" }] }),
    );

    const result = await searchMemory({ query: "needle" });

    expect(result.results).toEqual([{ id: "mem-1" }]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a read after a 4xx", async () => {
    stubFetch(async () =>
      jsonResponse({ error: { message: "bad query" } }, { status: 400 }),
    );

    const err = await captureError(searchMemory({ query: "needle" }));

    expect((err as MemoryApiError).status).toBe(400);
    expect((err as MemoryApiError).message).toBe("Memory API 400: bad query");
    expect(calls).toHaveLength(1);
  });

  it("never retries a store, and marks a timed-out store as outcome unknown", async () => {
    stubFetch(hangingFetch);

    const err = await captureError(
      storeMemory({ title: "T", text: "body", project: "p" }),
    );

    expect(err).toBeInstanceOf(MemoryApiError);
    expect((err as MemoryApiError).kind).toBe("timeout");
    expect((err as MemoryApiError).outcomeUnknown).toBe(true);
    expect((err as MemoryApiError).message).toContain("search before retrying");
    expect(calls).toHaveLength(1);
  });

  it("never retries an update or delete after a 5xx", async () => {
    stubFetch(async () =>
      jsonResponse({ error: { message: "boom" } }, { status: 500 }),
    );

    await captureError(updateMemory({ id: "mem-1", text: "x" }));
    await captureError(deleteMemory("mem-1"));

    expect(calls).toHaveLength(2);
    expect((await captureError(deleteMemory("mem-1"))) as MemoryApiError)
      .toMatchObject({ kind: "http", status: 500, outcomeUnknown: false });
  });

  it("maps a network failure on a write to outcome unknown", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const err = await captureError(
      storeMemory({ title: "T", text: "body", project: "p" }),
    );

    expect(err).toMatchObject({ kind: "network", outcomeUnknown: true });
    expect((err as Error).message).toContain("fetch failed");
  });

  it("surfaces a short snippet of a non-JSON error page", async () => {
    stubFetch(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
        }),
    );

    const err = await captureError(
      storeMemory({ title: "T", text: "body", project: "p" }),
    );

    expect(err).toMatchObject({ kind: "http", status: 502 });
    expect((err as Error).message).toBe(
      "Memory API 502: <html>502 Bad Gateway</html>",
    );
  });

  it("rejects a 2xx response whose body is not JSON", async () => {
    stubFetch(async () => new Response("not json", { status: 200 }));

    const err = await captureError(
      storeMemory({ title: "T", text: "body", project: "p" }),
    );

    expect(err).toMatchObject({ kind: "invalid-response", status: 200 });
  });

  it("keeps the secret-filter message and 400 status for callers", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          error: {
            code: 400,
            message: "Secret detected in text (rule: github-pat, position: 4): ghp_***",
          },
        },
        { status: 400 },
      ),
    );

    const err = await captureError(
      storeMemory({ title: "T", text: "body", project: "p" }),
    );

    expect(err).toMatchObject({ kind: "http", status: 400 });
    expect((err as Error).message).toContain("Secret detected in text");
  });

  it("bounds the health check with the same timeout", async () => {
    stubFetch(hangingFetch);

    const err = await captureError(ping());

    expect(err).toMatchObject({ kind: "timeout" });
  });

  it("falls back to the default timeout for an invalid MEMORY_API_TIMEOUT_MS", async () => {
    process.env.MEMORY_API_TIMEOUT_MS = "not-a-number";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await searchMemory({ query: "needle" });

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    timeoutSpy.mockRestore();
  });
});
