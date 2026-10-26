const DEFAULT_API_BASE_URL = "http://localhost:3100";
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_JITTER_MS = 300;
const NEVER_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export type MemoryApiErrorKind =
  | "http"
  | "timeout"
  | "network"
  | "invalid-response";

/**
 * Error from the memory API client. `kind` says what failed; `status` is set for HTTP errors.
 * `outcomeUnknown` is true when a write may or may not have been applied (timeout or network
 * failure after the request was sent), so callers should check before writing again.
 */
export class MemoryApiError extends Error {
  readonly kind: MemoryApiErrorKind;
  readonly status?: number;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    options: {
      kind: MemoryApiErrorKind;
      status?: number;
      outcomeUnknown?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "MemoryApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

function getTimeoutMs(): number {
  const raw = Number(process.env.MEMORY_API_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(): number {
  return RETRY_BASE_DELAY_MS + Math.random() * RETRY_JITTER_MS;
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/** One fetch bounded by the configured timeout, with failures mapped to MemoryApiError. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  isWrite: boolean,
): Promise<Response> {
  const timeoutMs = getTimeoutMs();
  const writeNote = isWrite
    ? "; the write may or may not have been applied, search before retrying"
    : "";
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new MemoryApiError(
        `Memory API request timed out after ${timeoutMs}ms${writeNote}`,
        { kind: "timeout", outcomeUnknown: isWrite, cause: err },
      );
    }
    // Node's fetch says only "fetch failed"; the system error code is on the cause.
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    const reason =
      (err instanceof Error ? err.message : String(err)) +
      (typeof code === "string" ? ` (${code})` : "");
    // These fail before the request is sent, so a write cannot have been applied.
    const neverSent =
      typeof code === "string" && NEVER_SENT_CODES.has(code);
    const unknown = isWrite && !neverSent;
    throw new MemoryApiError(
      `Memory API unreachable: ${reason}${unknown ? writeNote : ""}`,
      { kind: "network", outcomeUnknown: unknown, cause: err },
    );
  }
}

/** Parse a response body as JSON. Returns undefined for a body that is not JSON. */
function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessageFrom(json: unknown, text: string, res: Response): string {
  if (typeof json === "object" && json !== null) {
    const error = (json as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (
      typeof error === "object" &&
      error !== null &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
  }
  // Proxies and load balancers answer with HTML or plain text. Show a short prefix of it.
  const snippet = text.trim().slice(0, 200);
  return snippet && json === undefined ? snippet : res.statusText;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof MemoryApiError)) return false;
  if (err.kind === "timeout" || err.kind === "network") return true;
  return err.kind === "http" && err.status !== undefined && err.status >= 500;
}

function getApiBaseUrl(): string {
  return (
    process.env.MEMORY_API_BASE_URL ||
    process.env.MEMORY_API_URL ||
    process.env.SHARED_MEMORY_API_URL ||
    DEFAULT_API_BASE_URL
  ).replace(/\/+$/, "");
}

function getApiKey(): string {
  return (
    process.env.MEMORY_API_KEY ||
    process.env.SHARED_MEMORY_API_KEY ||
    process.env.SHARED_MEMORY_API_TOKEN ||
    ""
  );
}

function encodeQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) qs.set(key, value.join(","));
      continue;
    }
    qs.set(key, String(value));
  }
  return qs.toString();
}

async function request<T>(
  method: string,
  path: string,
  options: {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("MEMORY_API_KEY or SHARED_MEMORY_API_KEY is required");
  }

  const query = options.query ? encodeQuery(options.query) : "";
  const url = `${getApiBaseUrl()}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  const body = options.body ? JSON.stringify(options.body) : undefined;
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  // Only reads are retried. Writes are not idempotent (a retried store makes a duplicate),
  // so a failed write surfaces to the caller with outcomeUnknown set instead.
  const isWrite = method !== "GET";
  const attempts = isWrite ? 1 : 2;

  for (let attempt = 1; ; attempt++) {
    try {
      return await sendOnce<T>(url, { method, headers, body }, isWrite);
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      await sleep(retryDelayMs());
    }
  }
}

async function sendOnce<T>(
  url: string,
  init: RequestInit,
  isWrite: boolean,
): Promise<T> {
  const res = await fetchWithTimeout(url, init, isWrite);
  const text = await res.text();
  const json = parseJson(text);

  if (!res.ok) {
    throw new MemoryApiError(
      `Memory API ${res.status}: ${errorMessageFrom(json, text, res)}`,
      { kind: "http", status: res.status },
    );
  }

  if (json === undefined) {
    throw new MemoryApiError(
      `Memory API ${res.status}: response was not JSON`,
      { kind: "invalid-response", status: res.status },
    );
  }

  return json as T;
}

export async function storeMemory(params: {
  text: string;
  title: string;
  agent?: string;
  project: string;
  tags?: string[];
}): Promise<{ id: string }> {
  const result = await request<{ data: { id: string } }>(
    "POST",
    "/api/v1/memories",
    {
      body: params,
    },
  );
  return result.data;
}

export async function searchMemory(params: {
  query: string;
  limit?: number;
  agent?: string;
  project?: string;
  tags?: string[];
}): Promise<{ results: unknown[] }> {
  const result = await request<{ data: unknown[] }>(
    "GET",
    "/api/v1/memories/search",
    {
      query: {
        query: params.query,
        limit: params.limit,
        agent: params.agent,
        project: params.project,
        tags: params.tags,
      },
    },
  );
  return { results: result.data };
}

export async function listRecent(params: {
  limit?: number;
  days?: number;
  project?: string;
}): Promise<{ results: unknown[] }> {
  const result = await request<{ data: unknown[] }>(
    "GET",
    "/api/v1/memories/recent",
    {
      query: params,
    },
  );
  return { results: result.data };
}

export async function updateMemory(params: {
  id: string;
  text: string;
  title?: string;
}): Promise<{ success: boolean }> {
  const result = await request<{ data: { success: boolean } }>(
    "PUT",
    `/api/v1/memories/${params.id}`,
    {
      body: {
        text: params.text,
        title: params.title,
      },
    },
  );
  return result.data;
}

export async function loadMemories(
  ids: string[],
): Promise<{ results: unknown[] }> {
  const result = await request<{ data: unknown[] }>(
    "GET",
    "/api/v1/memories/load",
    {
      query: { ids },
    },
  );
  return { results: result.data };
}

export async function deleteMemory(id: string): Promise<{ success: boolean }> {
  const result = await request<{ data: { success: boolean } }>(
    "DELETE",
    `/api/v1/memories/${id}`,
  );
  return result.data;
}

export async function getConfig(): Promise<{
  apiBaseUrl: string;
  collectionName?: string;
  modelReady?: boolean;
}> {
  const result = await request<{
    data: { collectionName?: string; modelReady?: boolean };
  }>("GET", "/api/v1/config");
  return {
    apiBaseUrl: getApiBaseUrl(),
    collectionName: result.data.collectionName,
    modelReady: result.data.modelReady,
  };
}

export async function ping(): Promise<{ pong: boolean; modelReady: boolean }> {
  const res = await fetchWithTimeout(
    `${getApiBaseUrl()}/health`,
    { method: "GET" },
    false,
  );
  const body = parseJson(await res.text()) as
    | { modelReady?: boolean }
    | undefined;
  return { pong: res.ok, modelReady: Boolean(body?.modelReady) };
}
