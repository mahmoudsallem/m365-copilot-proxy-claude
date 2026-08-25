// Adaptive harness profiles — a typed, request-selectable tool/tooling policy
// layered over the existing M365_ALLOWED_TOOLS / M365_MAX_TOOLS machinery.
//
// Selection precedence: x-m365-profile header > M365_PROFILE env > claude-safe.
// Operator env overrides (M365_ALLOWED_TOOLS, M365_MAX_TOOLS,
// M365_NO_MULTI_TOOL) still win over whatever a profile specifies — profiles
// are defaults, not locks.

export const PROFILE_NAMES = [
  "claude-safe",
  "claude-web",
  "claude-diagnose",
  "claude-wide",
] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];
export const DEFAULT_PROFILE_NAME: ProfileName = "claude-safe";

export interface HarnessProfile {
  name: ProfileName;
  description: string;
  /**
   * Case-insensitive exact tool names that MAY be advertised. Empty = no
   * filtering (everything up to maxVisibleTools). Anything filtered out joins
   * the deferred ToolSearch catalog, so it stays callable via discovery.
   */
  allowedTools: string[];
  /** Hard cap on simultaneously advertised tools (deferred catalog holds the rest). */
  maxVisibleTools: number;
  /** Max matches returned per ToolSearch round. */
  toolSearchLimit: number;
  /** false = strict one-tool-per-turn even though batching is the norm elsewhere. */
  multiTool: boolean;
  /** Synthetic server-side Task sub-agent availability (off until bench-proven). */
  taskEnabled: boolean;
  /** Optional formatMessages framing variant override for the initial prompt. */
  framing?: string;
  /** Allow inline tone failover when this profile's model breaker opens. */
  toneFailover: boolean;
}

const CODING_TOOLS = ["bash", "read", "edit", "write", "glob", "grep", "todowrite"];
const WEB_TOOLS = ["webfetch", "websearch", "web_search", "fetch", "search"];

export const PROFILES: Record<ProfileName, HarnessProfile> = {
  "claude-safe": {
    name: "claude-safe",
    description:
      "Default lean coding surface: shell + file tools only, no synthetic Task, standard batching.",
    allowedTools: [...CODING_TOOLS],
    maxVisibleTools: 7,
    toolSearchLimit: 4,
    multiTool: true,
    taskEnabled: false,
    toneFailover: true,
  },
  "claude-web": {
    name: "claude-web",
    description:
      "Coding plus web capabilities; everything else stays reachable through deferred discovery.",
    allowedTools: [...CODING_TOOLS, ...WEB_TOOLS],
    maxVisibleTools: 9,
    toolSearchLimit: 5,
    multiTool: true,
    taskEnabled: false,
    toneFailover: true,
  },
  "claude-diagnose": {
    name: "claude-diagnose",
    description:
      "Read-heavy investigation: shell/read/search advertised, write/edit deferred so a diagnosis cannot mutate the workspace.",
    allowedTools: ["bash", "read", "glob", "grep"],
    maxVisibleTools: 6,
    toolSearchLimit: 6,
    multiTool: true,
    taskEnabled: false,
    toneFailover: true,
  },
  "claude-wide": {
    name: "claude-wide",
    description:
      "Every safe client-declared capability reachable: nothing filtered, capped manifest, ToolSearch promotes the rest.",
    allowedTools: [],
    maxVisibleTools: 10,
    toolSearchLimit: 8,
    multiTool: true,
    taskEnabled: true,
    toneFailover: true,
  },
};

export function listProfileNames(): string[] {
  return [...PROFILE_NAMES];
}

export function isProfileName(name: string): name is ProfileName {
  return PROFILE_NAMES.some((p) => p.toLowerCase() === name.toLowerCase());
}

export interface ProfileSelection {
  ok: true;
  source: "explicit" | "env" | "default";
  profile: HarnessProfile;
}

/**
 * Resolve a profile from an explicit request value. Precedence when
 * `explicit` is empty/undefined: M365_PROFILE env, then claude-safe.
 * Returns ok:false (with the supported list) ONLY for an explicitly provided
 * unknown name — env/default fall back silently to claude-safe.
 */
export function resolveProfile(explicit?: string): ProfileSelection | { ok: false; error: string } {
  const requested = explicit?.trim().toLowerCase();
  if (requested) {
    if (!isProfileName(requested)) {
      return {
        ok: false,
        error: `Unknown harness profile "${explicit}". Supported profiles: ${listProfileNames().join(", ")}`,
      };
    }
    return { ok: true, source: "explicit", profile: PROFILES[requested] };
  }

  const envValue = process.env.M365_PROFILE?.trim().toLowerCase();
  if (envValue && isProfileName(envValue)) {
    return { ok: true, source: "env", profile: PROFILES[envValue] };
  }
  return { ok: true, source: "default", profile: PROFILES[DEFAULT_PROFILE_NAME] };
}

/** True when `name` may be advertised under this profile (case-insensitive). */
export function toolAllowedByProfile(name: string, profile: HarnessProfile): boolean {
  if (profile.allowedTools.length === 0) return true;
  return profile.allowedTools.includes(name.toLowerCase());
}
