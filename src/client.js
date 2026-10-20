// The Qoder side: model listing and chat, spoken the way its client speaks
// them.

import { randomUUID } from "node:crypto"
import { cosyHeaders, encodeBody } from "./cosy.js"
import { IdentityCache } from "./identity.js"

export const API = "https://api3.qoder.sh"
export const MODELS_PATH = "/algo/api/v2/model/list?Encode=1"
export const CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"

const QODER_SYS = "You are a Qoder agent. Use the instructions below and the tools available to you to assist the user."
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

export const textOf = (content) => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("")
  return ""
}

// sessionTitle is what the client puts in business.name: the turn's own words,
// one line. A fixed name is a name no client sends.
function sessionTitle(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user")
  const text = textOf(last?.content ?? "").trim().split("\n").find((l) => l.trim()) ?? ""
  return text.trim().slice(0, 64) || "New Chat"
}

// pickEffort maps an OpenAI reasoning_effort onto the model's own levels: the
// nearest one, the higher on a tie.
export function pickEffort(asked, levels) {
  if (!asked || !levels?.length) return undefined
  const a = EFFORTS.indexOf(String(asked).toLowerCase())
  if (a < 0) return levels.at(-1)
  let best = levels[0]
  let bestD = Infinity
  for (const lvl of levels) {
    const i = EFFORTS.indexOf(lvl)
    const d = Math.abs(i - a)
    if (d < bestD || (d === bestD && i > EFFORTS.indexOf(best))) {
      best = lvl
      bestD = d
    }
  }
  return best
}

// contextWindow is the largest window the model offers, or the one asked for
// when the listing names it.
export function contextWindow(m) {
  const cfg = m?.context_config ?? {}
  const sizes = Object.values(cfg).map((v) => v?.token_count).filter((n) => Number.isFinite(n) && n > 0)
  if (sizes.length) return Math.max(...sizes)
  return Number(m?.max_input_tokens) || 0
}

// effortsOf is the reasoning levels a listing offers, when it names any.
export function effortsOf(m) {
  const tags = new Set()
  for (const s of m?.strategies ?? []) if (typeof s?.reasoning_effort === "string") tags.add(s.reasoning_effort)
  return tags.size ? [...tags] : m?.is_reasoning ? EFFORTS.slice(1) : []
}

// normalizeModels turns the listing into the model records this SDK uses.
export function normalizeModels(listing, scene = "chat") {
  const rows = Array.isArray(listing?.[scene]) ? listing[scene] : []
  return rows
    .filter((m) => m?.enable && m?.key && !["auto", "default"].includes(String(m.key).trim()))
    .map((m) => ({
      key: m.key,
      name: m.display_name || m.key,
      source: m.source ?? "system",
      reasoning: Boolean(m.is_reasoning),
      image: Boolean(m.is_vl),
      context: contextWindow(m),
      efforts: effortsOf(m),
      config: {
        key: m.key,
        display_name: m.display_name || m.key,
        model: "",
        format: m.format ?? "openai",
        is_vl: Boolean(m.is_vl),
        is_reasoning: Boolean(m.is_reasoning),
        api_key: "",
        url: "",
        source: m.source ?? "system",
        max_input_tokens: contextWindow(m),
      },
    }))
}

// requestBody is the plaintext agent_chat_generation takes.
export function requestBody(chat, model) {
  const messages = chat.messages ?? []
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n\n")
  const tools = chat.tool_choice !== "none" ? (chat.tools ?? []).filter((t) => t?.type === "function" && t.function?.name) : []
  let sysText = system ? `${QODER_SYS}\n\n${system}` : QODER_SYS
  if (chat.tool_choice === "required" && tools.length) sysText += "\nYou must call an available function in this response."
  const sys = { type: "text", text: sysText }

  const params = { enable_thinking: model.reasoning !== false, max_tokens: chat.max_tokens ?? 32000 }
  const effort = pickEffort(chat.reasoning_effort, model.efforts)
  if (effort) params.reasoning_effort = effort
  const window = model.context || 0
  if (window > 0) params.context_length = window

  const body = {
    parameters: params,
    business: {
      product: "app",
      version: undefined, // filled by the caller that knows the build
      type: "agent",
      id: randomUUID(),
      name: sessionTitle(messages),
      begin_at: Date.now(),
      stage: "start",
      model_key: model.key,
    },
    agent_id: "agent_common",
    task_id: "common",
    session_type: "app",
    model_config: model.config ?? { key: model.key },
    system: [sys],
    messages: [{ role: "system", content: [sys] }, ...convertMessages(messages)],
  }
  delete body.business.version
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? { type: "object", properties: {} },
      },
    }))
  }
  return body
}

// convertMessages keeps roles and tool plumbing as the client's own body holds
// them: assistant turns keep reasoning_content, tool results stay tool turns.
function convertMessages(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "tool") {
      out.push({ role: "tool", content: textOf(m.content), tool_call_id: m.tool_call_id })
      continue
    }
    if (m.role === "assistant") {
      const turn = { role: "assistant", content: textOf(m.content) }
      if (m.reasoning_content) turn.reasoning_content = m.reasoning_content
      if (m.tool_calls?.length) turn.tool_calls = m.tool_calls
      out.push(turn)
      continue
    }
    out.push({ role: "user", content: m.content })
  }
  return out
}

export class QoderClient {
  #creds
  #identity
  #onCreds
  #refreshJob

  constructor({ credentials, identity = new IdentityCache(), onCredentials, refreshJob } = {}) {
    this.#creds = credentials
    this.#identity = identity
    this.#onCreds = onCredentials
    this.#refreshJob = refreshJob
  }

  get credentials() {
    return this.#creds
  }

  async #identityFor() {
    try {
      return await this.#identity.get(this.#creds.uid)
    } catch {
      return null
    }
  }

  async #refresh() {
    if (!this.#refreshJob) throw new Error("the credential needs refreshing but no refresher was given")
    const next = await this.#refreshJob(this.#creds)
    this.#creds = next
    await this.#onCreds?.(next)
    return next
  }

  // models is the account's own listing, as the client asks for it.
  async models() {
    const url = API + MODELS_PATH
    const identity = await this.#identityFor()
    const call = () => fetch(url, { headers: cosyHeaders(url, this.#creds, "", { identity }), signal: AbortSignal.timeout(15_000) })
    let res = await call()
    if (res.status === 401 || res.status === 403) {
      // a lapsed sign-in is the caller's to see as 401; another failure is not
      await this.#refresh().catch((e) => {
        if (e.expired) e.status = 401
        throw e
      })
      res = await call()
    }
    const text = await res.text()
    if (!res.ok) throw Object.assign(new Error(`model list: HTTP ${res.status}: ${text.trim().slice(0, 300)}`), { status: res.status })
    return JSON.parse(text)
  }

  // chat posts a completion and returns the raw SSE response, so a caller can
  // stream it or read it whole.
  async chat(body, signal) {
    const url = API + CHAT_PATH
    const wire = encodeBody(JSON.stringify(body))
    const identity = await this.#identityFor()
    const send = () =>
      fetch(url, {
        method: "POST",
        headers: {
          ...cosyHeaders(url, this.#creds, wire, { identity }),
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Model-Key": body.model_config?.key ?? body.business?.model_key ?? "",
          "X-Model-Source": body.model_config?.source ?? "system",
        },
        body: wire,
        signal,
      })
    let res = await send()
    if (res.status === 401 || res.status === 403) {
      // a lapsed sign-in is the caller's to see as 401; another failure is not
      await this.#refresh().catch((e) => {
        if (e.expired) e.status = 401
        throw e
      })
      res = await send()
    }
    return res
  }
}
