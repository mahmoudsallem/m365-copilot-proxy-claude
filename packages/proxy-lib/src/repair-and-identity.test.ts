import { describe, expect, it } from "vitest";
import { repairBashCommands, SessionPool } from "./handler.js";

const bashCall = (command: string) => ({
  function: { name: "bash", arguments: JSON.stringify({ command }) },
});

describe("repairBashCommands", () => {
  it("strips CRLF from multi-line commands (Git-Bash 'unexpected EOF' killer)", () => {
    const calls = [bashCall("cat > f.txt <<'EOF'\r\nline one\r\nline two\r\nEOF\r\n")];
    expect(repairBashCommands(calls)).toBe(1);
    const cmd = JSON.parse(calls[0].function.arguments).command;
    expect(cmd).not.toContain("\r");
    expect(cmd).toContain("line one\nline two\nEOF\n");
  });

  it("appends a missing heredoc terminator", () => {
    const calls = [bashCommand_missingTerminator()];
    expect(repairBashCommands(calls)).toBe(1);
    const cmd = JSON.parse(calls[0].function.arguments).command;
    expect(cmd.split("\n").some((l: string) => l.trim() === "EOF")).toBe(true);
  });

  it("leaves already-clean commands untouched", () => {
    const clean = "echo 'hello world' && ls -la";
    const calls = [bashCall(clean)];
    expect(repairBashCommands(calls)).toBe(0);
    expect(JSON.parse(calls[0].function.arguments).command).toBe(clean);
  });

  it("ignores non-bash tools and unparseable arguments", () => {
    const calls = [
      { function: { name: "read_file", arguments: JSON.stringify({ path: "a\r\nb" }) } },
      { function: { name: "bash", arguments: "{not json" } },
    ];
    expect(repairBashCommands(calls)).toBe(0);
  });

  function bashCommand_missingTerminator() {
    return bashCall("cat > out.txt <<'EOF'\ncontent line");
  }
});

describe("SessionPool conversation identity", () => {
  const messages = () => [{ role: "user" as const, content: "list the files in src" }];

  it("same first message + model on DIFFERENT session keys get separate conversations", () => {
    const pool = new SessionPool();
    const a = pool.resolve(messages(), "gpt-5.5", "client-A");
    const b = pool.resolve(messages(), "gpt-5.5", "client-B");
    expect(a).not.toBe(b);
    expect(pool.size).toBe(2);
  });

  it("same key, message and model reuse one conversation", () => {
    const pool = new SessionPool();
    const a = pool.resolve(messages(), "gpt-5.5", "client-A");
    const b = pool.resolve(messages(), "gpt-5.5", "client-A");
    expect(a).toBe(b);
    expect(pool.size).toBe(1);
  });

  it("fingerprints are sha256-stable and distinct per model without a session key", () => {
    const pool = new SessionPool();
    const fpModelA = pool.fingerprintOf(messages(), "model-a");
    const fpModelB = pool.fingerprintOf(messages(), "model-b");
    expect(fpModelA).not.toBe(fpModelB);
    expect(fpModelA).toMatch(/^[0-9a-f]{64}$/);
    // Legacy no-key requests remain content+model keyed.
    expect(pool.resolve(messages(), "model-a")).toBe(pool.resolve(messages(), "model-a"));
  });
});
