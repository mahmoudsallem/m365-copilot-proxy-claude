import { JwtClaims } from "./schemas.js";

// Kept as re-exports for source compatibility. The capability registry is the
// single source of truth for tone routing and model discovery.
export { getToneForModel, getAvailableModels } from "./models.js";

export function decodeJwt(token: string) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const raw = JSON.parse(Buffer.from(padded, "base64").toString());
  return JwtClaims.parse(raw);
}

/**
 * The streaming result of one M365 Copilot turn. Implemented by
 * `CopilotSession.chat` (session.ts); async-iterate it for delta text and read
 * the getters for the turn's diagnostic metadata after it completes.
 */
/** One generated image, as carried on a GraphicArt frame (§14). URLs point at
 *  designerapp.officeapps.live.com and need the designerappservice token to
 *  fetch — see `fetchImageBytes` / `generateImage`. */
export interface CapturedImage {
  referenceUrls: string[];
  fileToken?: string;
  pollUrl?: string;
  size?: string;
  orientation?: string;
  /** Server status; 2 = ready (observed). */
  status?: number;
}

export interface CapturedSourceAttribution {
  sourceId?: string;
  url: string;
  title?: string;
  excerpt?: string;
  provider?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(objects: Array<Record<string, unknown>>, keys: string[]): string | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/** Normalize the several attribution shapes observed from Bing/M365 frames. */
export function normalizeSourceAttribution(value: unknown): CapturedSourceAttribution | null {
  const root = record(value);
  if (!root) return null;
  const candidates = [
    root,
    record(root.attribution),
    record(root.source),
    record(root.reference),
    record(root.metadata),
  ].filter((entry): entry is Record<string, unknown> => !!entry);
  const rawUrl = firstString(candidates, ["url", "seeMoreUrl", "sourceUrl", "webUrl", "href", "link"]);
  if (!rawUrl) return null;
  let parsedUrl: URL;
  try { parsedUrl = new URL(rawUrl); } catch { return null; }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) return null;
  parsedUrl.hash = "";
  for (const key of [...parsedUrl.searchParams.keys()]) {
    if (/(?:api[_-]?key|auth|cookie|credential|mfa|pass(?:word)?|secret|signature|sig|token)/i.test(key)) {
      parsedUrl.searchParams.delete(key);
    }
  }
  const url = parsedUrl.toString();
  return {
    sourceId: firstString(candidates, ["sourceId", "citationId", "id"]),
    url,
    title: firstString(candidates, ["title", "displayName", "name", "providerDisplayName"]),
    excerpt: firstString(candidates, ["snippet", "excerpt", "summary", "description"]),
    provider: firstString(candidates, ["provider", "providerDisplayName", "sourceType"]),
  };
}

export interface CopilotStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  fullText: string;
  /** Generated images captured this turn (empty unless image gen was requested
   *  and the server returned a GraphicArt frame). */
  images: CapturedImage[];
  /** Normalized Bing/M365 grounding records captured from response frames. */
  sourceAttributions: CapturedSourceAttribution[];
  /** True if the server returned content (deltas or full text) */
  hasContent: boolean;
  /** Throttle info if provided by M365 */
  throttle: { current: number; max: number } | null;
  /** `DeepLeo` (reasoning) / `3PDeclarativeAgent` (agent) / etc.  */
  contentOrigin?: string | null;
  /** Last seen messageType (e.g. `Disengaged`, `EndOfRequest`). Null when M365 sends an unmistakably content message. */
  messageType?: string | null;
  /** Server-assigned bot message id, useful for telemetry correlation. */
  messageId?: string | null;
  /** Per-message classifier scores from M365 (BotOffense / dea_violation).
   *  Highest values across the response. Drives the "how close to Disengaged are we" metric. */
  scores?: Record<string, number> | null;
  /** Authoritative server-side turn count for this conversation. */
  turnCount?: number | null;
  /** `Completed` etc. */
  turnState?: string | null;
  /** True if the model triggered a native custom action this turn (H-NATIVE-6). */
  sawAction?: boolean;
}
