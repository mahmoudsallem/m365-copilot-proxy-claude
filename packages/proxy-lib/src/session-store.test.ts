import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./session-store.js";
import { SessionPool } from "./handler.js";

const tmpDirs: string[] = [];
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m365-store-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.M365_SESSION_STORE_PATH;
});

const RECORD = { conversationId: "cid-1234", sentMessageCount: 7, lastUsedAt: Date.now() };

describe("SessionStore (persistent session durability)", () => {
  it("round-trips records through flush + reload with all fields intact", () => {
    const file = tmpFile("sessions.json");
    const a = new SessionStore(file);
    a.set("fp-1", RECORD);
    a.flush();

    const b = new SessionStore(file);
    expect(b.get("fp-1")).toEqual(RECORD);
  });

  it("returns an empty store when the file does not exist", () => {
    const store = new SessionStore(tmpFile("missing.json"));
    expect(store.get("anything")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("survives a corrupt snapshot: starts empty, next flush overwrites it", () => {
    const file = tmpFile("corrupt.json");
    fs.writeFileSync(file, "{ this is not json", "utf8");
    const store = new SessionStore(file);
    expect(store.size).toBe(0);

    store.set("fp-2", RECORD);
    store.flush();
    expect(new SessionStore(file).get("fp-2")).toEqual(RECORD);
  });

  it("flush leaves no .tmp behind and delete removes records", () => {
    const file = tmpFile("atomic.json");
    const store = new SessionStore(file);
    store.set("fp-3", RECORD);
    store.flush();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);

    store.delete("fp-3");
    store.flush();
    expect(new SessionStore(file).get("fp-3")).toBeNull();
  });
});

describe("SessionPool hydration (restart resumes the M365 thread)", () => {
  const SESSION_OPTS = {
    getToken: async () => "fake-token",
    useAgent: false,
    transport: { chat: async () => ({}) as never },
  };

  it("a new pool resumes the persisted conversationId + delta position", () => {
    process.env.M365_SESSION_STORE_PATH = tmpFile("hydrate.json");
    const messages = [{ role: "user" as const, content: "seed message for fingerprint" }];

    // Process A: one conversation makes progress, then "dies".
    const poolA = new SessionPool(SESSION_OPTS);
    const stateA = poolA.resolve(messages, "m365-copilot");
    const cidA = stateA.session.conversationId;
    stateA.sentMessageCount = 4;
    poolA.persistConversation(poolA.fingerprintOf(messages, "m365-copilot"), stateA);

    // Process B (fresh pool, same store file): must RESUME, not start over.
    const poolB = new SessionPool(SESSION_OPTS);
    const stateB = poolB.resolve(messages, "m365-copilot");
    expect(stateB.session.conversationId).toBe(cidA);
    expect(stateB.sentMessageCount).toBe(4);
  });

  it("ignores stale records older than the idle-eviction window", () => {
    const file = tmpFile("stale.json");
    const fresh = new SessionStore(file);
    fresh.set("stale-fp", { conversationId: "old-cid", sentMessageCount: 9, lastUsedAt: Date.now() - 31 * 60 * 1000 });
    fresh.flush();

    process.env.M365_SESSION_STORE_PATH = file;
    const pool = new SessionPool(SESSION_OPTS);
    // Any request fingerprints differently from "stale-fp", so seed via the
    // same key the store holds by writing through the store again post-load:
    const messages = [{ role: "user" as const, content: "stale check" }];
    const fp = pool.fingerprintOf(messages, "m365-copilot");
    fresh.set(fp, { conversationId: "old-cid", sentMessageCount: 9, lastUsedAt: Date.now() - 31 * 60 * 1000 });
    fresh.flush();

    const state = pool.resolve(messages, "m365-copilot");
    expect(state.session.conversationId).not.toBe("old-cid");
    expect(state.sentMessageCount).toBe(0);
  });
});
