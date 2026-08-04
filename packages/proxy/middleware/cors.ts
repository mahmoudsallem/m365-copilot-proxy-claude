/** The local CLI client never sends a browser Origin. Reject browser-initiated
 * requests so arbitrary pages cannot consume the user's M365 account through
 * localhost. */
export default defineEventHandler((event) => {
  if (getHeader(event, "origin")) {
    throw createError({ statusCode: 403, statusMessage: "Browser origins are not allowed" });
  }
  if (event.method === "OPTIONS") return sendNoContent(event, 204);
});
