export type ProxyErrorCode =
  | "UNSUPPORTED_MODEL"
  | "M365_THREAD_THROTTLED"
  | "M365_AGENT_INCOMPATIBLE"
  | "M365_INVALID_SESSION"
  | "M365_CONTENT_FILTERED"
  | "M365_EMPTY_RESPONSE"
  | "M365_UPSTREAM_ERROR"
  | "M365_AUTHENTICATION_FAILED"
  | "M365_BAD_REQUEST";

export class M365ProxyError extends Error {
  readonly status: number;
  readonly code: ProxyErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    message: string;
    status: number;
    code: ProxyErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "M365ProxyError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

export class UnsupportedModelError extends M365ProxyError {
  readonly requestedModel: string;
  readonly supportedModels: string[];

  constructor(requestedModel: string, supportedModels: string[], customMessage?: string) {
    const message =
      customMessage ??
      `Unsupported model "${requestedModel}". Select one of: ${supportedModels.slice(0, 10).join(", ")}${
        supportedModels.length > 10 ? "..." : ""
      }.`;
    super({
      message,
      status: 400,
      code: "UNSUPPORTED_MODEL",
      retryable: false,
      details: { requestedModel, supportedModels },
    });
    this.name = "UnsupportedModelError";
    this.requestedModel = requestedModel;
    this.supportedModels = supportedModels;
  }
}

const SENSITIVE_KEYS = /^(authorization|cookie|token|access_token|refresh_token|secret|api_key|password)$/i;

/** Recursively redact sensitive fields from objects before logging or error responses. */
export function redactSensitive<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(redactSensitive) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(k)) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      result[k] = redactSensitive(v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}
