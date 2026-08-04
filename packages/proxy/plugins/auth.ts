import { getToken } from "@m365-copilot/core";

/**
 * Authenticate against M365 once, at server startup. A failure here throws and
 * aborts boot — the equivalent of the old binary's `process.exit(1)` on auth
 * failure, so the server never comes up half-broken.
 */
export default defineNitroPlugin(async () => {
  if (process.env.M365_REQUIRE_API_KEY === "1" && !process.env.M365_PROXY_API_KEY) {
    throw new Error(
      "M365_PROXY_API_KEY is required. Run `pnpm setup:local` and start with `pnpm proxy:local`.",
    );
  }
  console.log("Authenticating...");
  try {
    await getToken();
  } catch (err: any) {
    console.error(`Auth failed: ${err.message}`);
    throw err;
  }
});
