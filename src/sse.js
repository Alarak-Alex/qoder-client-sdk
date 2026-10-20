// Turning Qoder's SSE into OpenAI chat-completion chunks.
//
// Each `data:` line carries an envelope whose `body` is itself an OpenAI
// chunk, plus a status. Reasoning arrives as delta.reasoning_content and tool
// calls either as delta.tool_calls or as text the client writes them in.

import { textOf } from "./client.js"

// sseLines yields one line at a time from a byte stream, without holding the
// whole body in memory.
export async function* sseLines(body) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      yield line
    }
  }
  buf += dec.decode()
  if (buf) yield buf.replace(/\r$/, "")
}

// frames yields the parsed envelope of each data line, skipping anything that
// isn't one.
export async function* frames(body) {
  for await (const line of sseLines(body)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      yield JSON.parse(payload)
    } catch {}
  }
}

// Qoder's own error codes carry the meaning; a bare status hides it. 10605 is
// a queue position, not a lapsed sign-in: only 105 is that.
const QUOTA = new Set(["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"])
const REQUEST = new Set(["406", "416", "430", "80411", "80412", "100400", "100401", "100403"])
const BUSY = new Set(["10605"])

export function describeFailure(status, text) {
  let message = String(text ?? "").trim()
  let code = ""
  try {
    const j = JSON.parse(message)
    code = String(j?.code ?? j?.errorCode ?? "")
    message = String(j?.message ?? j?.msg ?? message)
  } catch {}
  const m = message.match(/"code"\s*:\s*"?(\d+)"?/)
  if (!code && m) code = m[1]
  const kind = QUOTA.has(code)
    ? "quota"
    : BUSY.has(code)
      ? "busy"
      : REQUEST.has(code)
        ? "request"
        : code === "105"
          ? "auth"
          : status === 401 || status === 403
            ? "auth"
            : "other"
  return { status, code, kind, message: message.slice(0, 2000) }
}

// streamChat converts Qoder's SSE into OpenAI `chat.completion.chunk` events.
// It yields plain objects; the caller serialises them.
export async function* streamChat(body, { id, model, includeReasoning = true }) {
  let created = Math.floor(Date.now() / 1000)
  let finish = null
  let usage = null
  let index = -1
  const native = new Map()

  const chunk = (delta, finishReason = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  yield chunk({ role: "assistant" })

  for await (const env of frames(body)) {
    if (env?.statusCodeValue != null && env.statusCodeValue !== 200) {
      const inner = typeof env.body === "string" ? env.body : ""
      const f = describeFailure(Number(env.statusCodeValue), inner || JSON.stringify(env))
      const err = new Error(f.message)
      Object.assign(err, { status: f.status, code: f.code, kind: f.kind })
      throw err
    }
    const inner = typeof env?.body === "string" ? env.body.trim() : ""
    if (!inner) continue
    if (inner === "[DONE]") break
    let piece
    try {
      piece = JSON.parse(inner)
    } catch {
      continue
    }
    if (piece.created) created = piece.created
    if (piece.usage) usage = piece.usage
    const choice = piece?.choices?.[0]
    const delta = choice?.delta ?? {}
    if (choice?.finish_reason) finish = choice.finish_reason

    if (delta.reasoning_content && includeReasoning) {
      yield chunk({ reasoning_content: delta.reasoning_content })
    }
    if (typeof delta.content === "string" && delta.content) {
      yield chunk({ content: delta.content })
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0)
      let slot = native.get(i)
      if (!slot) {
        slot = { index: ++index, id: tc.id ?? `call_${id}_${i}` }
        native.set(i, slot)
        yield chunk({ tool_calls: [{ index: slot.index, id: slot.id, type: "function", function: { name: tc.function?.name ?? "", arguments: "" } }] })
      }
      if (tc.function?.arguments) {
        yield chunk({ tool_calls: [{ index: slot.index, function: { arguments: tc.function.arguments } }] })
      }
    }
  }

  yield { ...chunk({}, finish ?? "stop"), ...(usage ? { usage } : {}) }
}

// readChat collects a non-streaming answer from the same SSE.
export async function readChat(body, { id, model }) {
  let content = ""
  let reasoning = ""
  const tools = new Map()
  let usage = null
  let finish = "stop"
  for await (const piece of streamChat(body, { id, model })) {
    for (const c of piece.choices ?? []) {
      const d = c.delta ?? {}
      if (d.content) content += d.content
      if (d.reasoning_content) reasoning += d.reasoning_content
      for (const tc of d.tool_calls ?? []) {
        const slot = tools.get(tc.index) ?? { id: tc.id, type: "function", function: { name: "", arguments: "" } }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.function.name = tc.function.name
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
        tools.set(tc.index, slot)
      }
      if (c.finish_reason) finish = c.finish_reason
    }
    if (piece.usage) usage = piece.usage
  }
  const message = { role: "assistant", content: content || null }
  if (reasoning) message.reasoning_content = reasoning
  if (tools.size) message.tool_calls = [...tools.values()]
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: tools.size ? "tool_calls" : finish }],
    ...(usage ? { usage: toOpenAIUsage(usage) } : {}),
  }
}

// toOpenAIUsage maps Qoder's counters onto OpenAI's.
export function toOpenAIUsage(u) {
  if (!u) return undefined
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    ...(u.prompt_tokens_details?.cached_tokens != null
      ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
      : {}),
    ...(u.completion_tokens_details?.reasoning_tokens != null
      ? { completion_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } }
      : {}),
  }
}
