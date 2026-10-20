// The OpenAI-compatible surface: /v1/models and /v1/chat/completions.

import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { QoderClient, normalizeModels, requestBody } from "./client.js"
import { COSY_VERSION } from "./cosy.js"
import { describeFailure, readChat, streamChat } from "./sse.js"

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (c) => {
      body += c
      if (body.length > 32 * 1024 * 1024) reject(new Error("request body too large"))
    })
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })

const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

const errorBody = (message, type, code) => ({ error: { message, type, code } })

// createApp builds the server. apiKey, when set, is required as a bearer token
// so the port can't be used by anything else on the machine.
export function createApp({ client, apiKey, defaultModel, modelCacheMs = 5 * 60 * 1000 } = {}) {
  let cached = { at: 0, models: [] }

  const models = async () => {
    if (Date.now() - cached.at < modelCacheMs && cached.models.length) return cached.models
    const listing = await client.models()
    cached = { at: Date.now(), models: normalizeModels(listing, "chat") }
    return cached.models
  }

  const pick = async (asked) => {
    const list = await models()
    const key = asked || defaultModel || list.find((m) => m.key === "ultimate")?.key || list[0]?.key
    const found = list.find((m) => m.key === key || m.name === key)
    if (!found) throw Object.assign(new Error(`unknown model "${key}"`), { status: 400 })
    return found
  }

  const authorised = (req) => !apiKey || req.headers.authorization === `Bearer ${apiKey}`

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    try {
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true, account: client.credentials?.accountId ?? null })
      if (!authorised(req)) return sendJson(res, 401, errorBody("invalid api key", "authentication_error", "invalid_api_key"))

      if (url.pathname === "/v1/models" && req.method === "GET") {
        const list = await models()
        return sendJson(res, 200, {
          object: "list",
          data: list.map((m) => ({ id: m.key, object: "model", created: 0, owned_by: "qoder", name: m.name, context_window: m.context })),
        })
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = await readJson(req)
        const model = await pick(body.model)
        const payload = requestBody(body, model)
        payload.business.version = COSY_VERSION
        const id = `chatcmpl-${randomUUID()}`
        const ac = new AbortController()
        req.on("close", () => ac.abort())
        const upstream = await client.chat(payload, ac.signal)
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "")
          const f = describeFailure(upstream.status, text)
          return sendJson(res, f.status, errorBody(f.message, f.kind === "quota" ? "insufficient_quota" : "api_error", f.code || String(f.status)))
        }
        if (!body.stream) {
          const answer = await readChat(upstream.body, { id, model: model.key })
          return sendJson(res, 200, answer)
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        try {
          for await (const piece of streamChat(upstream.body, { id, model: model.key })) {
            res.write(`data: ${JSON.stringify(piece)}\n\n`)
          }
          res.write("data: [DONE]\n\n")
        } catch (e) {
          res.write(`data: ${JSON.stringify(errorBody(e.message, e.kind === "quota" ? "insufficient_quota" : "api_error", e.code || "upstream_error"))}\n\n`)
        }
        return res.end()
      }

      sendJson(res, 404, errorBody(`no route for ${req.method} ${url.pathname}`, "invalid_request_error", "not_found"))
    } catch (e) {
      if (res.headersSent) return res.end()
      sendJson(res, e.status ?? 500, errorBody(e.message ?? String(e), "api_error", e.code ?? "internal_error"))
    }
  })
}

// serve starts the app on host:port.
export function serve({ host = "127.0.0.1", port = 8787, ...rest } = {}) {
  const server = createApp(rest)
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve(server))
  })
}
