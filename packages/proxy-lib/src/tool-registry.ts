import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

export interface RegisteredToolDefinition {
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ToolCallLike {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ToolCallValidation =
  | { ok: true; call: ToolCallLike; repaired: boolean; repairs: string[] }
  | { ok: false; code: "unknown_tool" | "invalid_json" | "invalid_arguments"; message: string; errors?: string[] };

const PROPERTY_ALIAS_GROUPS = [
  ["path", "file_path", "filepath"],
  ["command", "cmd", "script"],
  ["pattern", "regex", "query"],
  ["directory", "dir", "folder"],
] as const;

function aliasScore(source: string, target: string): number {
  const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (canonical(source) === canonical(target)) return 2;
  return PROPERTY_ALIAS_GROUPS.some((group) => group.includes(source.toLowerCase() as never)
    && group.includes(target.toLowerCase() as never)) ? 1 : 0;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? error.keyword}`.trim();
  });
}

/**
 * Per-request registry for client-declared tools. It retains the complete JSON
 * Schema and guarantees that only schema-valid calls cross the Anthropic/OpenAI
 * boundary. M365 still produces prompt-emulated intent; this is adapter-side
 * validation, not native constrained decoding.
 */
export class ToolSchemaRegistry {
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly schemas = new Map<string, Record<string, unknown>>();
  readonly definitionErrors: string[] = [];

  constructor(definitions: RegisteredToolDefinition[]) {
    // Claude Code declares draft-2020-12 schemas (including `$schema`), while
    // many OpenAI clients omit the dialect. Ajv2020 accepts both shapes.
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    for (const definition of definitions) {
      const name = definition.function.name;
      if (this.validators.has(name)) {
        this.definitionErrors.push(`Duplicate tool name "${name}".`);
        continue;
      }
      const candidate = definition.function.parameters ?? { type: "object", properties: {} };
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        this.definitionErrors.push(`Tool "${name}" has a non-object input schema.`);
        continue;
      }
      try {
        const schema = candidate as Record<string, unknown>;
        this.validators.set(name, ajv.compile(schema));
        this.schemas.set(name, schema);
      } catch (error) {
        this.definitionErrors.push(`Tool "${name}" has an invalid input schema: ${(error as Error).message}`);
      }
    }
  }

  validateAndRepair(call: ToolCallLike): ToolCallValidation {
    const validate = this.validators.get(call.function.name);
    if (!validate) {
      return { ok: false, code: "unknown_tool", message: `Model requested undeclared tool "${call.function.name}".` };
    }

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { ok: false, code: "invalid_json", message: `Tool "${call.function.name}" emitted malformed JSON arguments.` };
    }
    if (validate(args)) return { ok: true, call, repaired: false, repairs: [] };

    const repaired = this.repairPropertyAliases(call.function.name, args);
    if (repaired && validate(repaired.value)) {
      return {
        ok: true,
        call: { ...call, function: { ...call.function, arguments: JSON.stringify(repaired.value) } },
        repaired: true,
        repairs: repaired.repairs,
      };
    }

    const errors = formatErrors(validate.errors);
    return {
      ok: false,
      code: "invalid_arguments",
      message: `Tool "${call.function.name}" arguments do not match its JSON Schema.`,
      errors,
    };
  }

  private repairPropertyAliases(
    name: string,
    value: unknown,
  ): { value: Record<string, unknown>; repairs: string[] } | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const schema = this.schemas.get(name);
    const properties = schema?.properties;
    const required = Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;

    const result = { ...(value as Record<string, unknown>) };
    const known = new Set(Object.keys(properties));
    const missing = required.filter((property) => !(property in result));
    const extras = Object.keys(result).filter((property) => !known.has(property));
    const repairs: string[] = [];

    for (const target of missing) {
      const candidates = extras
        .map((source) => ({ source, score: aliasScore(source, target) }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
      if (candidates.length !== 1) continue;
      const source = candidates[0].source;
      result[target] = result[source];
      delete result[source];
      extras.splice(extras.indexOf(source), 1);
      repairs.push(`${source}->${target}`);
    }

    return repairs.length > 0 ? { value: result, repairs } : null;
  }
}
