import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SUBAGENT_TOOL_NAME,
  makeTaskToolDef,
  execSubTool,
  runSubAgent,
} from "./subagent.js";import type { ModelSession } from "@m365-copilot/core";

// --- Fixtures: a temp workspace ---

let root = "";
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-ws-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "answer.txt"), "THE_ANSWER_IS_42");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "const x = 41;\n// TODO find the answer\nexport default x;\n");
  process.env.M365_WORKSPACE_ROOT = root;
});
afterAll(() => {
  delete process.env.M365_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restricted sub-agent tools (read-only, workspace-jailed)", () => {
  it("validateSubToolArgs returns corrective errors", () => {
    const v = (n: string, a: Record<string, unknown>) => {
      // re-import via execSubTool error text instead — validate is internal.
      return execSubTool(n, a).startsWith("ERROR:");
    };
    expect(v("read_file", { path: "missing-file-xyz.txt" })).toBe(true);
    expect(v("read_file", { path: "" })).toBe(true);
    expect(v("read_file", { path: "../../../etc/passwd" })).toBe(true);
    expect(v("grep_files", { pattern: "[" })).toBe(true); // invalid regex
    expect(v("bash", { command: "ls" })).toBe(true);      // unknown tool
  });

  it("read_file reads within the workspace", () => {
    expect(execSubTool("read_file", { path: "answer.txt" })).toBe("THE_ANSWER_IS_42");
    expect(execSubTool("read_file", { path: "src/app.ts" })).toContain("TODO");
  });

  it("read_file refuses paths outside the workspace", () => {
    expect(execSubTool("read_file", { path: "../../../etc/hosts" })).toMatch(/escapes the workspace/);
    expect(execSubTool("read_file", { path: "C:/Windows/win.ini" })).toMatch(/escapes the workspace/);
  });

  it("glob_files matches with ** patterns and skips node_modules/.git", () => {
    const out = execSubTool("glob_files", { pattern: "**/*.ts" });
    expect(out).toContain("src/app.ts");
    const all = execSubTool("glob_files", { pattern: "**/*" });
    expect(all).toContain("answer.txt");
  });

  it("grep_files returns file:line matches", () => {
    const out = execSubTool("grep_files", { pattern: "TODO" });
    expect(out).toMatch(/src\/app\.ts:\d+:.*TODO/);
  });
});

describe("Task tool synthesis + full delegation loop", () => {
  it("advertises a Task def", () => {
    const def = makeTaskToolDef();
    expect(def.function.name).toBe(SUBAGENT_TOOL_NAME);
    expect(JSON.stringify(def)).toContain("read-only");
  });
  it("runs a bounded loop: sub explores via tools then reports; report is returned", async () => {
    // Scripted transport keyed on prompt content:
    //   sub turn 1 → explore via read_file fence
    //   sub turn 2 → final prose report
    let sawExplore = false;
    const fakeSession = {
      run: async (_text: string) => {
        if (!sawExplore) {
          sawExplore = true;
          return mkStream("```read_file\nanswer.txt\n```");
        }
        return mkStream("The answer file contains THE_ANSWER_IS_42. Report complete.");
      },
    } as unknown as ModelSession;

    const report = await runSubAgent(fakeSession, "claude-sonnet", "Read answer.txt and report its contents.");
    expect(sawExplore).toBe(true);
    expect(report).toContain("THE_ANSWER_IS_42");
  });

  it("returns a budget note when the sub never stops emitting fences", async () => {
    process.env.M365_SUBAGENT_TURNS = "2";
    const fakeSession = {
      run: async () => mkStream("```read_file\nanswer.txt\n```"),
    } as unknown as ModelSession;
    const report = await runSubAgent(fakeSession, "gpt-5.5", "loop forever");
    expect(report).toMatch(/turn budget/);
    delete process.env.M365_SUBAGENT_TURNS;
  });
});

function mkStream(text: string): any {
  return {
    fullText: text,
    hasContent: true,
    images: [],
    throttle: null,
    contentOrigin: null,
    messageType: null,
    messageId: "x",
    scores: {},
    turnCount: 1,
    turnState: "Completed",
    async *[Symbol.asyncIterator]() { yield text; },
  };
}
