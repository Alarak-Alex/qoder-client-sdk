// The OpenAI-compatible surface: /v1/models and /v1/chat/completions over a
// pool of Qoder accounts, plus the admin API and the page that drives it.

import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { normalizeModels, requestBody } from "./client.js"
import { COSY_VERSION } from "./cosy.js"
import { SITES, deviceSignIn, patSignIn } from "./auth.js"
import { conversationOf } from "./pool.js"
import { readChat, streamChat } from "./sse.js"

const WEB = new URL("../web/", import.meta.url)

const readJson = (req, limit = 32 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (c) => {
      body += c
      if (body.length > limit) reject(new Error("request body too large"))
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

const bearer = (req) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")
  return (m?.[1] ?? req.headers["x-api-key"] ?? "").trim()
}

// createApp builds the server over a pool. apiKey guards the OpenAI surface,
// adminKey the admin one; a key left unset leaves that surface open, so run
// that way only on loopback.
export function createApp({ pool, store, apiKey, adminKey, defaultModel, modelCacheMs = 5 * 60 * 1000 } = {}) {
  if (!pool || !store) throw new Error("createApp needs a pool and a store")

  const listings = new Map() // account id → { at, models }
  const logins = new Map() // one browser sign-in at a time, keyed

  const clientOf = (id) => {
    if (!store.creds(id)) throw Object.assign(new Error(`account ${id} is gone`), { skip: true })
    return pool.clientFor(id)
  }

  const modelsOf = async (id) => {
    const hit = listings.get(id)
    if (hit && Date.now() - hit.at < modelCacheMs && hit.models.length) return hit.models
    let listing
    try {
      listing = await clientOf(id).models()
    } catch (e) {
      // a refused sign-in is the account's: kept, so it stops being tried
      if (e.expired || e.status === 401 || e.status === 403) await store.lapsed(id, true)
      throw e
    }
    const list = normalizeModels(listing, "chat")
    listings.set(id, { at: Date.now(), models: list })
    return list
  }

  // knownModels is the union over the accounts that are on, each account's
  // listing being its own.
  const knownModels = async () => {
    const seen = new Map()
    let last = null
    for (const a of store.list().filter((x) => x.enabled && !x.needsLogin)) {
      let list = []
      try {
        list = await modelsOf(a.id)
      } catch (e) {
        last = e
        continue
      }
      for (const m of list) if (!seen.has(m.key)) seen.set(m.key, m)
    }
    // nothing at all is not an empty catalogue: it is the accounts' failure
    if (!seen.size && last) throw last
    return [...seen.values()]
  }

  // payloadFor builds one account's request, with that account's own model
  // record; a model it doesn't list is left to the next account.
  const payloadFor = async (accountId, body) => {
    const list = await modelsOf(accountId)
    const key = body.model || defaultModel
    const model = key ? list.find((m) => m.key === key || m.name === key) : list.find((m) => m.key === "ultimate") ?? list[0]
    if (!model) throw Object.assign(new Error(`account ${accountId} has no model "${key}"`), { skip: true })
    const payload = requestBody(body, model)
    payload.business.version = COSY_VERSION
    return { payload, model }
  }

  const guard = (req, key) => !key || bearer(req) === key || req.headers["x-admin-key"] === key

  const view = () => ({ accounts: pool.snapshot(), log: pool.trace(80), policy: store.policy })

  // ---- admin -------------------------------------------------------------

  async function admin(req, res, url) {
    const [, , resource, id, action] = url.pathname.split("/").filter(Boolean)
    const done = () => sendJson(res, 200, view())

    if (resource === "state" && req.method === "GET") return done()

    if (resource === "policy" && req.method === "POST") {
      await store.setPolicy(await readJson(req))
      return done()
    }
    if (resource === "refresh" && req.method === "POST") {
      await pool.refreshAll()
      return done()
    }
    if (resource === "logout" && req.method === "POST") {
      for (const a of store.list()) await store.remove(a.id)
      return done()
    }

    // POST /admin/api/login — start the browser sign-in; GET …/<key> polls it
    if (resource === "login" && id === undefined && req.method === "POST") {
      const key = randomUUID()
      const entry = { url: "", status: "pending", account: "", error: "", at: Date.now() }
      logins.set(key, entry)
      deviceSignIn(SITES.qoder, { onUrl: (u) => (entry.url = u) })
        .then(async (creds) => {
          await store.add(creds)
          entry.status = "done"
          entry.account = creds.accountId
          void pool.refreshUsage(creds.uid)
        })
        .catch((e) => {
          entry.status = "error"
          entry.error = e.message
        })
      for (const [k, v] of logins) if (Date.now() - v.at > 20 * 60 * 1000) logins.delete(k)
      return sendJson(res, 200, { id: key, url: entry.url, status: entry.status })
    }
    if (resource === "login" && id === "pat" && req.method === "POST") {
      const { pat } = await readJson(req)
      const creds = await patSignIn(String(pat ?? "").trim(), SITES.qoder)
      await store.add(creds)
      void pool.refreshUsage(creds.uid)
      return done()
    }
    if (resource === "login" && id && req.method === "GET") {
      const entry = logins.get(id)
      if (!entry) return sendJson(res, 404, errorBody("no such sign-in", "invalid_request_error", "not_found"))
      return sendJson(res, 200, { id, url: entry.url, status: entry.status, account: entry.account, error: entry.error })
    }

    if (resource === "accounts" && id && store.get(id)) {
      if (action === "enabled" && req.method === "POST") {
        const { enabled } = await readJson(req)
        await store.setEnabled(id, enabled)
        return done()
      }
      if (action === "unrest" && req.method === "POST") {
        pool.clearRest(id)
        return done()
      }
      if (action === "usage" && req.method === "POST") {
        await pool.refreshUsage(id)
        return done()
      }
      if (!action && req.method === "DELETE") {
        await store.remove(id)
        return done()
      }
    }

    return sendJson(res, 404, errorBody(`no admin route for ${req.method} ${url.pathname}`, "invalid_request_error", "not_found"))
  }

  // ---- routing -----------------------------------------------------------

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    const path = url.pathname
    try {
      if (path === "/health") {
        const accounts = pool.snapshot()
        return sendJson(res, 200, {
          ok: true,
          accounts: accounts.length,
          usable: accounts.filter((a) => a.enabled && !a.needsLogin && !a.resting).length,
        })
      }

      if (path === "/" || path === "/ui") {
        const html = await readFile(new URL("index.html", WEB)).catch(() => null)
        if (!html) return sendJson(res, 500, errorBody("the web UI is missing", "api_error", "no_ui"))
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" })
        return res.end(html)
      }

      if (path.startsWith("/admin/api/")) {
        if (!guard(req, adminKey ?? apiKey)) return sendJson(res, 401, errorBody("invalid admin key", "authentication_error", "invalid_api_key"))
        return await admin(req, res, url)
      }

      if (!guard(req, apiKey)) return sendJson(res, 401, errorBody("invalid api key", "authentication_error", "invalid_api_key"))

      if (path === "/v1/models" && req.method === "GET") {
        const list = await knownModels()
        return sendJson(res, 200, {
          object: "list",
          data: list.map((m) => ({ id: m.key, object: "model", created: 0, owned_by: "qoder", name: m.name, context_window: m.context })),
        })
      }

      if (path === "/v1/chat/completions" && req.method === "POST") {
        const body = await readJson(req)
        const id = `chatcmpl-${randomUUID()}`
        const ac = new AbortController()
        req.on("close", () => ac.abort())
        const conversation = { id: conversationOf(req.headers, body), body }

        const { account, upstream, model } = await pool.run({
          conversation,
          signal: ac.signal,
          build: (accountId) => payloadFor(accountId, body),
        })

        if (!body.stream) {
          const answer = await readChat(upstream.body, { id, model: model.key })
          pool.served(account.id, answer.usage?.total_tokens)
          pool.stick(conversation.id, account.id)
          void pool.refreshUsage(account.id)
          return sendJson(res, 200, answer)
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        let total = 0
        try {
          for await (const piece of streamChat(upstream.body, { id, model: model.key })) {
            if (piece.usage?.total_tokens) total = piece.usage.total_tokens
            res.write(`data: ${JSON.stringify(piece)}\n\n`)
          }
          res.write("data: [DONE]\n\n")
          pool.served(account.id, total)
          pool.stick(conversation.id, account.id)
          void pool.refreshUsage(account.id)
        } catch (e) {
          res.write(`data: ${JSON.stringify(errorBody(e.message, e.kind === "quota" ? "insufficient_quota" : "api_error", e.code || "upstream_error"))}\n\n`)
        }
        return res.end()
      }

      return sendJson(res, 404, errorBody(`no route for ${req.method} ${path}`, "invalid_request_error", "not_found"))
    } catch (e) {
      if (res.headersSent) return res.end()
      const status = e.status ?? 500
      const type = e.kind === "quota" ? "insufficient_quota" : status === 503 ? "service_unavailable" : "api_error"
      return sendJson(res, status, errorBody(e.message ?? String(e), type, e.code ?? "internal_error"))
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
