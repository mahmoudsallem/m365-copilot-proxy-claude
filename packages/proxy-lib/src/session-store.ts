// Persistent session store — proxy restarts no longer burn fresh M365
// conversation starts (thread-rate throttle, docs/hypotheses.md F13).
//
// The SessionPool fingerprints conversations by first-user-message + model +
// caller key; that fingerprint is stable across restarts (the client resends
// its full history), so it doubles as the on-disk key. On hydration a stored
// ConversationId is seeded into the new ModelSession and sentMessageCount is
// restored so delta prompting continues exactly where the previous process
// left off.
//
// Durability model: single process, JSON snapshot, write-to-temp-then-rename
// so a crash mid-write can never corrupt the previous good snapshot.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@m365-copilot/core";

const log = createLogger("session-store");

export interface PersistedSession {
  /** Live M365 ConversationId to resume. */
  conversationId: string;
  /** How many request messages the previous process had already sent. */
  sentMessageCount: number;
  lastUsedAt: number;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, PersistedSession>;
}

export function defaultSessionStorePath(): string {
  return join(homedir(), ".config", "opencode-m365", "sessions.json");
}

export class SessionStore {
  private cache: Map<string, PersistedSession> | null = null;

  constructor(readonly filePath: string = defaultSessionStorePath()) {}

  private load(): Map<string, PersistedSession> {
    if (this.cache) return this.cache;
    this.cache = new Map();
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
        for (const [key, rec] of Object.entries(parsed.sessions)) {
          if (
            rec &&
            typeof rec.conversationId === "string" &&
            Number.isFinite(rec.sentMessageCount) &&
            Number.isFinite(rec.lastUsedAt)
          ) {
            this.cache.set(key, rec);
          }
        }
      }
      if (this.cache.size > 0) {
        log.info(`Loaded ${this.cache.size} persisted session(s) from ${this.filePath}`);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        // A corrupt snapshot must never take the proxy down — start empty and
        // let the next flush overwrite it.
        log.warn(`Session store unreadable (${err?.message ?? err}); starting empty`);
      }
    }
    return this.cache;
  }

  get(key: string): PersistedSession | null {
    return this.load().get(key) ?? null;
  }

  set(key: string, record: PersistedSession): void {
    this.load().set(key, record);
  }

  delete(key: string): void {
    this.load().delete(key);
  }

  get size(): number {
    return this.load().size;
  }

  /**
   * Atomically persist the current map: write to `<path>.tmp` then rename over
   * the target. Rename within the same directory is atomic on NTFS/POSIX, so
   * concurrent writers (or a crash) can only ever leave a complete old file or
   * a complete new file — never a torn one.
   */
  flush(): void {
    const sessions: Record<string, PersistedSession> = {};
    for (const [key, rec] of this.load()) sessions[key] = rec;
    const payload: StoreFile = { version: 1, sessions };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err: any) {
      log.warn(`Session store flush failed: ${err?.message ?? err}`);
    }
  }
}
