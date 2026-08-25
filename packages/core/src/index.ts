export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  getImageArtifactToken,
  loginAutomated,
  loginInteractive,
  loginInteractiveForScopes,
  loginDeviceCode,
  loginDeviceCodeForScopes,
  loadSecrets,
  forceReauth,
  type DeviceCodePrompt,
} from "./auth.js";

export {
  generateImage,
  fetchImageBytes,
  buildImagePrompt,
  classifyImageFailure,
  ImageGenerationError,
  type GeneratedImage,
  type GenerateImageOptions,
  type ImageOrientation,
  type ImageStyle,
  type ImageGenFailureReason,
} from "./image.js";

export {
  noteRequestOutcome,
  awaitDegradationBackoff,
  isDegradationBackoff,
  createBackoffController,
  type BackoffController,
  type BackoffOptions,
} from "./auth-recovery.js";

export {
  M365ProxyError,
  UnsupportedModelError,
  redactSensitive,
  type ProxyErrorCode,
} from "./errors.js";

export { getOrCreateAgent, getOrCreateAgentSingleFlight } from "./agent.js";

export {
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  resolveModel,
  normalizeModelName,
  CANONICAL_MODELS,
  MODEL_ALIASES,
  type ModelConfig,
  type ResolvedModel,
  type BackendFamily,
  type ToolMode,
  type CopilotStream,
  type CapturedImage,
} from "./copilot.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
  type ChatTurnOptions,
  type NativeActionConfig,
} from "./session.js";

export {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  buildNativeActionPrompt,
  NATIVE_ACTION_INSTRUCTIONS,
  ACTION_ALLOWED_MESSAGE_TYPES,
  ACTION_CONFIRM_MESSAGE_TYPES,
  type ActionConfirmation,
} from "./native-actions.js";

export {
  ModelSession,
  RealM365Transport,
  type ModelSessionOptions,
  type ModelTransport,
} from "./model.js";

export {
  FakeTransport,
  type FakeTransportOptions,
} from "./fake.js";

export {
  listSystemPrompts,
  getSystemPrompt,
  resolveSystemPromptSpec,
  findSystemPromptIndex,
  clearSystemPromptCache,
  type SystemPromptMeta,
} from "./prompts.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  isProseDocument,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";

export {
  formatFencedToolDefinitions,
  deriveFencedSpec,
  parseFencedToolCalls,
  FRAMING_VARIANT_NAMES,
} from "./fenced.js";
