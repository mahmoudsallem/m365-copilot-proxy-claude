import { describe, expect, it } from "vitest";
import { formatTaskProgress } from "./progress.js";

describe("CLI progress", () => {
  it("emits a stable run id before a long blocking workflow", () => {
    expect(formatTaskProgress("task-123", "created")).toBe("run-id: task-123 created\n");
    expect(formatTaskProgress("task-123", "plan-submitted")).toContain("task-123");
    expect(formatTaskProgress("task-123", "queued")).toContain("queued");
  });
});
