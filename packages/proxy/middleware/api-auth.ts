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

  const expected = process.env.M365_PROXY_API_KEY;
  if (!expected) {
    if (process.env.M365_REQUIRE_API_KEY === "1") {
      throw createError({ statusCode: 503, statusMessage: "Proxy API key is not configured" });
    }
    return;
  }

  const authorization = getHeader(event, "authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!equalSecret(actual, expected)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid proxy API key" });
  }
});
