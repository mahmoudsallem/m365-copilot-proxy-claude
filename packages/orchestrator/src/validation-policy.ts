import type { MyClaudePlan } from "./schemas.js";

export interface ValidationPolicyDecision {
  command: string;
  allowed: boolean;
  executable?: string;
  args?: string[];
  reasons: string[];
  mode: "enforced";
}

const SHELL_COMPOSITION = /[\n\r;&|><`$()'"\\*?\[\]{}!]/;
const SAFE_TOKEN = /^[A-Za-z0-9_@./:=,+%^-]+$/;
const UNSAFE_ARGUMENTS = new Set([
  "--cwd", "--dir", "--prefix", "--global", "-g",
  "--registry", "--update", "--install", "--yes",
  "--exec", "-exec", "--shell", "--script-shell",
  "--output", "-o", "--out", "--out-dir", "--basetemp",
  "--fix", "--write", "--watch", "--watchall", "-u", "--updatesnapshot",
  "--target-dir", "--coverprofile", "-coverprofile", "--junitxml", "--html", "--cov-report",
  "--results-directory", "--artifacts-path",
]);

/**
 * Parse the narrow deterministic validation language. The returned argv is
 * executed directly without a shell, so accepted plans cannot smuggle shell
 * composition through MCP or the JSON plan artifact.
 */
export function evaluateValidationCommand(command: string): ValidationPolicyDecision {
  const reasons: string[] = [];
  const trimmed = command.trim();
  if (!trimmed) reasons.push("validation command is empty");
  if (SHELL_COMPOSITION.test(trimmed)) reasons.push("shell composition, quoting, redirection, expansion, and globbing are forbidden");
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  for (const token of tokens) {
    if (!SAFE_TOKEN.test(token)) reasons.push(`unsupported command token: ${token}`);
    const argumentValue = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (argumentValue.startsWith("/") || argumentValue.startsWith("~") || argumentValue.split("/").includes("..")) reasons.push(`path escapes the repository: ${token}`);
    if (token.includes("://")) reasons.push(`network URL is forbidden: ${token}`);
    const option = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (UNSAFE_ARGUMENTS.has(option.toLowerCase())) reasons.push(`external execution/write option is forbidden: ${option}`);
  }
  if (tokens[0]?.includes("=")) reasons.push("environment assignment prefixes are forbidden");
  if (reasons.length === 0 && !matchesAllowedShape(tokens)) reasons.push("command is not an allowlisted deterministic repo-local validator");
  return {
    command,
    allowed: reasons.length === 0,
    ...(reasons.length === 0 ? { executable: tokens[0], args: tokens.slice(1) } : {}),
    reasons: [...new Set(reasons)],
    mode: "enforced",
  };
}

export function evaluatePlanValidation(plan: MyClaudePlan): ValidationPolicyDecision[] {
  return plan.validation.commands.map((item) => evaluateValidationCommand(item.command));
}

export function assertSafeValidationPlan(plan: MyClaudePlan): ValidationPolicyDecision[] {
  const decisions = evaluatePlanValidation(plan);
  const blocked = decisions.filter((decision) => !decision.allowed);
  if (blocked.length > 0) {
    const detail = blocked.map((decision) => `${JSON.stringify(decision.command)}: ${decision.reasons.join("; ")}`).join(" | ");
    throw new Error(`validation policy rejected plan: ${detail}`);
  }
  return decisions;
}

function matchesAllowedShape(tokens: string[]): boolean {
  const [executable, first, second] = tokens.map((token) => token?.toLowerCase());
  if (!executable || !first) return false;
  const isValidationScript = (value: string | undefined) => Boolean(value && /^(?:test|lint|build|typecheck)(?::[a-z0-9_-]+)*$/.test(value));
  if (executable === "pnpm" || executable === "npm" || executable === "yarn") {
    return isValidationScript(first) || (first === "run" && isValidationScript(second));
  }
  if (executable === "bun") return first === "test" || (first === "run" && isValidationScript(second));
  if (executable === "npx") {
    return first === "--no-install" && new Set(["vitest", "jest", "eslint", "tsc"]).has(second);
  }
  if (executable === "cargo") return new Set(["test", "check", "clippy"]).has(first);
  if (executable === "go") return first === "test";
  if (executable === "pytest" || executable === "pytest-3") return true;
  if (executable === "dotnet") return first === "test";
  return false;
}
