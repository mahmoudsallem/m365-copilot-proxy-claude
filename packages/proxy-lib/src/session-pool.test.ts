import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, markMessagesSent } from "./handler.js";

function messages(text = "same first request") {
  return ChatCompletionRequest.parse({
    model: "m365-copilot",
    messages: [{ role: "user", content: text }],
  }).messages;
}

describe("SessionPool isolation and serialization", () => {
  it("serializes requests carrying the same explicit UUID and reuses one session", async () => {
    const pool = new SessionPool({}, { maxConcurrency: 2 });
    const id = randomUUID();
    const first = await pool.acquire(messages(), id);
    let secondAcquired = false;
    const pending = pool.acquire(messages(), id).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquired).toBe(false);
    first.release();

    const second = await pending;
    expect(second.state.session).toBe(first.state.session);
    expect(second.state.clientSessionId).toBe(id);
    second.release();
  });

  it("isolates different explicit UUIDs when global concurrency permits", async () => {
    const pool = new SessionPool({}, { maxConcurrency: 2 });
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = await pool.acquire(messages(), firstId);
    const second = await pool.acquire(messages(), secondId);

    expect(first.state.session).not.toBe(second.state.session);
    expect(first.state.session.sessionId).toBe(firstId);
    expect(second.state.session.sessionId).toBe(secondId);
    first.release();
    second.release();
  });

  it("enforces the global scheduler across different sessions", async () => {
    const pool = new SessionPool({}, { maxConcurrency: 1 });
    const first = await pool.acquire(messages("first"), randomUUID());
    let secondAcquired = false;
    const pending = pool.acquire(messages("second"), randomUUID()).then((lease) => {
      secondAcquired = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await pending;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it("uses a process-salted compatibility id for header-less generic clients", async () => {
    const pool = new SessionPool({}, { maxConcurrency: 2 });
    const first = await pool.acquire(messages("legacy request"));
    const effective = first.state.clientSessionId;
    expect(effective).toMatch(/^[0-9a-f-]{36}$/);
    first.release();

    const followupMessages = ChatCompletionRequest.parse({
      model: "m365-copilot",
      messages: [
        { role: "user", content: "legacy request" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow up" },
      ],
    }).messages;
    const followup = await pool.acquire(followupMessages);
    expect(followup.state.clientSessionId).toBe(effective);
    expect(followup.state.session).toBe(first.state.session);
    followup.release();
  });

  it("rotates the upstream conversation and forces a full seed after compaction", async () => {
    const pool = new SessionPool({}, { maxConcurrency: 2 });
    const id = randomUUID();
    const original = ChatCompletionRequest.parse({
      model: "m365-copilot",
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: "old response" },
        { role: "user", content: "old follow-up" },
      ],
    }).messages;
    const first = await pool.acquire(original, id);
    const originalConversation = first.state.session.conversationId;
    markMessagesSent(first.state, original);
    first.release();

    // Equal message count, different prefix: length-only detection would miss it.
    const compacted = ChatCompletionRequest.parse({
      model: "m365-copilot",
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: "Compacted summary of all prior work" },
        { role: "user", content: "continue from the summary" },
      ],
    }).messages;
    const second = await pool.acquire(compacted, id);
    expect(second.state.session.conversationId).not.toBe(originalConversation);
    // The handler's full-transcript branch is selected whenever this is zero.
    expect(second.state.sentMessageCount).toBe(0);
    expect(second.state.sentTranscriptDigest).toBeNull();
    second.release();
  });

  it("rejects malformed explicit session identifiers", async () => {
    const pool = new SessionPool();
    await expect(pool.acquire(messages(), "not-a-uuid")).rejects.toThrow(
      "X-M365-Session-ID must be a UUID",
    );
  });
});
