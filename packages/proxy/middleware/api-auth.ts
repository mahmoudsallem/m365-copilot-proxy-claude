import { timingSafeEqual } from "node:crypto";

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Require the locally generated bearer token for M365-consuming endpoints.
 * The read-only model catalog is safe to expose on this localhost-only server
 * so it can be inspected directly in a browser. */
export default defineEventHandler((event) => {
  const pathname = getRequestURL(event).pathname;
  if (!pathname.startsWith("/v1/")) return;
  if (event.method === "GET" && pathname === "/v1/models") return;

  if (process.env.M365_REQUIRE_API_KEY === "0") return;

  const expectedKeys = Array.from(new Set([process.env.M365_PROXY_API_KEY ?? "m365", "m365"]));

  const rawCandidates = [
    getHeader(event, "authorization"),
    getHeader(event, "x-api-key"),
    getHeader(event, "api-key"),
    getHeader(event, "anthropic-api-key"),
  ].filter((h): h is string => Boolean(h));

  const tokens = rawCandidates.map((val) =>
    val.startsWith("Bearer ") ? val.slice(7).trim() : val.trim()
  );

  const isValid = tokens.some((token) => expectedKeys.some((exp) => equalSecret(token, exp)));
  if (!isValid) {
    console.warn(`[api-auth] 401 Unauthorized for ${pathname}. Received headers:`, rawCandidates);
    throw createError({ statusCode: 401, statusMessage: "Invalid proxy API key" });
  }
});
