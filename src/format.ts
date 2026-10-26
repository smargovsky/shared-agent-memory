import { SearchResult } from "./types.js";

/** Compact "by X" / "created by X, updated by Y" attribution, or "" if unknown. */
export function formatAttribution(r: SearchResult): string {
  const creator = r.createdBy;
  const updater = r.updatedBy;
  if (creator && updater && creator !== updater) {
    return `created by ${creator}, updated by ${updater}`;
  }
  const who = creator || updater;
  return who ? `by ${who}` : "";
}

/** Created/Updated metadata line for full memory display, including actor names. */
export function formatMeta(r: SearchResult): string {
  const parts = [
    `Created: ${r.created_at}${r.createdBy ? ` by ${r.createdBy}` : ""}`,
  ];
  const updatedAt = r.updatedAt || r.updated_at;
  const changed =
    (updatedAt && updatedAt !== r.created_at) ||
    (r.updatedBy && r.updatedBy !== r.createdBy);
  if (changed) {
    parts.push(
      `Updated: ${updatedAt || r.created_at}${r.updatedBy ? ` by ${r.updatedBy}` : ""}`,
    );
  }
  return parts.join(" | ");
}

/** Search hits as compact title lines. Full text comes from formatLoadedMemories. */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No memories found.";
  return results
    .map((r, i) => {
      const who = formatAttribution(r);
      return `[${i + 1}] (score: ${r.score.toFixed(3)}) [${r.project}] ${r.id}\n${r.title || "(untitled)"}${who ? ` — ${who}` : ""}`;
    })
    .join("\n");
}

/** Loaded memories with full text, tags, and created/updated metadata. */
export function formatLoadedMemories(results: SearchResult[]): string {
  if (results.length === 0) return "No memories found for the given IDs.";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] [${r.agent}/${r.project}]\nID: ${r.id}\nTitle: ${r.title || "(untitled)"}\n${r.text}\nTags: ${Array.isArray(r.tags) ? r.tags.join(", ") : "none"} | ${formatMeta(r)}`,
    )
    .join("\n\n");
}

/** Recent memories as compact title lines with creation time. */
export function formatRecent(results: SearchResult[]): string {
  if (results.length === 0) return "No recent memories.";
  return results
    .map((r, i) => {
      const who = formatAttribution(r);
      return `[${i + 1}] [${r.project}] ${r.id} ${r.created_at}\n${r.title || "(untitled)"}${who ? ` — ${who}` : ""}`;
    })
    .join("\n");
}

export function formatConfig(
  config: { apiBaseUrl: string; collectionName?: string; modelReady?: boolean },
  defaults: { agent: string; project: string },
): string {
  return `Memory API: ${config.apiBaseUrl}\nCollection: ${config.collectionName}\nDefault Agent: ${defaults.agent}\nDefault Project: ${defaults.project}\nModel Ready: ${config.modelReady}`;
}
