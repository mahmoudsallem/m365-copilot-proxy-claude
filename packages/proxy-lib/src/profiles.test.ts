import { describe, it, expect, afterEach } from "vitest";
import {
  PROFILES,
  PROFILE_NAMES,
  DEFAULT_PROFILE_NAME,
  listProfileNames,
  isProfileName,
  resolveProfile,
  toolAllowedByProfile,
} from "./profiles.js";

afterEach(() => {
  delete process.env.M365_PROFILE;
});

describe("profile registry", () => {
  it("defines exactly the four harness profiles", () => {
    expect(listProfileNames()).toEqual(["claude-safe", "claude-web", "claude-diagnose", "claude-wide"]);
  });

  it("claude-safe: lean coding surface, no synthetic Task", () => {
    const p = PROFILES["claude-safe"];
    expect(p.allowedTools).toContain("bash");
    expect(p.allowedTools).toContain("todowrite");
    expect(p.allowedTools).not.toContain("webfetch");
    expect(toolAllowedByProfile("Bash", p)).toBe(true);
    expect(toolAllowedByProfile("WebFetch", p)).toBe(false);
    expect(p.taskEnabled).toBe(false);
  });

  it("claude-diagnose: read-first, write/edit deferred", () => {
    const p = PROFILES["claude-diagnose"];
    expect(toolAllowedByProfile("Read", p)).toBe(true);
    expect(toolAllowedByProfile("Grep", p)).toBe(true);
    expect(toolAllowedByProfile("Edit", p)).toBe(false);
    expect(toolAllowedByProfile("Write", p)).toBe(false);
  });

  it("claude-web adds web capabilities on top of coding", () => {
    const p = PROFILES["claude-web"];
    expect(toolAllowedByProfile("Bash", p)).toBe(true);
    expect(toolAllowedByProfile("WebFetch", p)).toBe(true);
    expect(toolAllowedByProfile("web_search", p)).toBe(true);
    expect(p.taskEnabled).toBe(false);
  });

  it("claude-wide filters nothing and is the only profile with synthetic Task", () => {
    const wide = PROFILES["claude-wide"];
    expect(wide.allowedTools).toEqual([]);
    expect(toolAllowedByProfile("AnythingAtAll", wide)).toBe(true);
    expect(wide.taskEnabled).toBe(true);
    for (const name of PROFILE_NAMES) {
      if (name !== "claude-wide") expect(PROFILES[name].taskEnabled).toBe(false);
    }
  });

  it("manifest caps stay in sane bounds, widest profile has the largest cap", () => {
    for (const name of PROFILE_NAMES) {
      expect(PROFILES[name].maxVisibleTools).toBeGreaterThanOrEqual(5);
      expect(PROFILES[name].maxVisibleTools).toBeLessThanOrEqual(12);
    }
    expect(PROFILES["claude-wide"].maxVisibleTools)
      .toBeGreaterThanOrEqual(PROFILES["claude-safe"].maxVisibleTools);
  });
});

describe("resolveProfile precedence", () => {
  it("explicit valid name wins", () => {
    process.env.M365_PROFILE = "claude-wide";
    const sel = resolveProfile("Claude-Diagnose"); // case/space tolerant
    expect(sel.ok && sel.source).toBe("explicit");
    expect(sel.ok && sel.profile.name).toBe("claude-diagnose");
  });

  it("explicit invalid name is a hard error listing the supported set", () => {
    const sel = resolveProfile("claude-yolo");
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.error).toContain("claude-safe");
    if (!sel.ok) expect(sel.error).toContain("claude-wide");
  });

  it("falls back to M365_PROFILE env when no explicit value", () => {
    process.env.M365_PROFILE = "claude-web";
    const sel = resolveProfile(undefined);
    expect(sel.ok && sel.source).toBe("env");
    expect(sel.ok && sel.profile.name).toBe("claude-web");
  });

  it("invalid M365_PROFILE env silently falls back to the default (routes enforce strictly)", () => {
    process.env.M365_PROFILE = "nope";
    const sel = resolveProfile(undefined);
    expect(sel.ok && sel.source).toBe("default");
    expect(sel.ok && sel.profile.name).toBe(DEFAULT_PROFILE_NAME);
  });

  it("default with nothing set anywhere is claude-safe", () => {
    const sel = resolveProfile();
    expect(sel.ok && sel.source).toBe("default");
    expect(sel.ok && sel.profile.name).toBe("claude-safe");
  });

  it("isProfileName rejects junk and accepts canonical names", () => {
    expect(isProfileName("claude-safe")).toBe(true);
    expect(isProfileName("CLAUDE-WIDE")).toBe(true);
    expect(isProfileName("yolo")).toBe(false);
  });
});
