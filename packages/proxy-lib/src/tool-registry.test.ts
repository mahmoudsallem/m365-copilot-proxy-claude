import { describe, expect, it } from "vitest";
import { ToolSchemaRegistry, type ToolCallLike } from "./tool-registry.js";

const definitions = [{
  function: {
    name: "Read",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { file_path: { type: "string" }, mode: { type: "string", enum: ["text", "bytes"] } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
}];

function call(name: string, args: string): ToolCallLike {
  return { id: "call_1", type: "function", function: { name, arguments: args } };
}

describe("ToolSchemaRegistry", () => {
  it("accepts valid nested JSON-Schema input", () => {
    const registry = new ToolSchemaRegistry(definitions);
    expect(registry.validateAndRepair(call("Read", JSON.stringify({ file_path: "src/app.ts", mode: "text" })))).toMatchObject({ ok: true, repaired: false });
  });

  it("repairs a single high-confidence property alias and revalidates", () => {
    const registry = new ToolSchemaRegistry(definitions);
    const result = registry.validateAndRepair(call("Read", JSON.stringify({ path: "src/app.ts" })));
    expect(result).toMatchObject({ ok: true, repaired: true, repairs: ["path->file_path"] });
    if (result.ok) expect(JSON.parse(result.call.function.arguments)).toEqual({ file_path: "src/app.ts" });
  });

  it("rejects malformed JSON, unknown tools, enums, and extra properties", () => {
    const registry = new ToolSchemaRegistry(definitions);
    expect(registry.validateAndRepair(call("Read", "{"))).toMatchObject({ ok: false, code: "invalid_json" });
    expect(registry.validateAndRepair(call("DeleteEverything", "{}"))).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(registry.validateAndRepair(call("Read", JSON.stringify({ file_path: "x", mode: "wrong" })))).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(registry.validateAndRepair(call("Read", JSON.stringify({ file_path: "x", surprise: true })))).toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("reports invalid and duplicate client schemas before a turn", () => {
    const registry = new ToolSchemaRegistry([
      ...definitions,
      ...definitions,
      { function: { name: "Broken", parameters: { type: "definitely-not-a-json-schema-type" } } },
    ]);
    expect(registry.definitionErrors).toHaveLength(2);
  });
});
