// The public surface: sign in, then talk to Qoder as its own client does.

export { COSY_VERSION, ALPHABET, encodeBody, decodeBody, cosyHeaders, userBlob } from "./cosy.js"
export { ENVIRONMENT, IdentityCache, readIdentity, identityRuntime } from "./identity.js"
export { SITES, credentialsPath, deviceSignIn, loadCredentials, patSignIn, refreshJob, saveCredentials } from "./auth.js"
export {
  CHAT_PATH,
  MODELS_PATH,
  QoderClient,
  contextWindow,
  effortsOf,
  normalizeModels,
  pickEffort,
  requestBody,
} from "./client.js"
export { describeFailure, frames, readChat, sseLines, streamChat, toOpenAIUsage } from "./sse.js"
export { createApp, serve } from "./server.js"
