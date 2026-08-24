import { getToken } from "@m365-copilot/core";

/**
 * Authenticate against M365 once, at server startup. A failure here throws and
 * aborts boot — the equivalent of the old binary's `process.exit(1)` on auth
 * failure, so the server never comes up half-broken.
 *
 * Skipped entirely in M365_FAKE_MODE (scripted offline backend for E2E/sandbox).
 */
export default defineNitroPlugin(async () => {
  if (process.env.M365_REQUIRE_API_KEY === "1" && !process.env.M365_PROXY_API_KEY) {
    throw new Error(
      "M365_PROXY_API_KEY is required. Run `pnpm setup:local` and start with `pnpm proxy:local`.",
    );
  }
  if (process.env.M365_FAKE_MODE === "1") {
    console.log("M365_FAKE_MODE=1 — scripted offline backend; skipping startup auth.");
    return;
  }
  console.log("Authenticating against Microsoft 365...");
  try {
    await getToken();
    console.log("Authenticated against Microsoft 365 successfully.");
  } catch (err: any) {
    console.warn(`Startup auth notice: ${err.message}. Server online; auth will be re-attempted on request.`);
  }
});
