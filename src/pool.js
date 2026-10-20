// The pool: how a request picks one of the accounts, the way magpie routes a
// provider's accounts — an order by what each has left, a rest after a
// failure, and a conversation staying where it was answered.

import { createHash } from "node:crypto"
import { IdentityCache } from "./identity.js"
import { describeFailure, peek, refusalOf } from "./sse.js"

// Shares of an allowance past which an account is kept for when the others
// can't take the request.
export const LOW_SHARE = 90
export const USED_SHARE = 100
// How long an account sits out, by why it failed.
export const RESTS = { quota: 15 * 60 * 1000, busy: 30 * 1000, auth: 0, request: 0, network: 15 * 1000, other: 60 * 1000 }
// A conversation nobody has answered yet still holds its account this long.
const HELD_FOR = 30 * 60 * 1000
// Half-life of what an account served lately, as magpie weighs it.
const HALF_LIFE = 60 * 60 * 1000

// share is what an account has used of its allowance: the fullest window, or
// the account's own percentage when it names one. A plan with no credits
// states no window at all, and its isQuotaExceeded is not trusted: an
// account that says so answered while one that didn't was out — what is
// unknown is left unknown, and routing weighs it by what it served.
const share = (usage) => {
  if (!usage || usage.error) return null
  if (usage.windows.length) return usage.windows.reduce((m, w) => Math.max(m, w.share), 0)
  // no window stated: the account's own percentage, when it says one that
  // means something. Every plan here says 0 with no credits behind it, so a
  // zero is left unknown rather than read as full.
  return usage.percent > 0 ? usage.percent : null
}

// conversationOf names what a request belongs to: the header when the caller
// gives one, else its system line and first words, which repeat on every
// turn of the same conversation and differ between conversations.
export function conversationOf(headers, body) {
  const given = String(headers?.["x-conversation-id"] ?? headers?.["x-session-id"] ?? "").trim()
  if (given) return given.slice(0, 128)
  const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "")
  const msgs = body?.messages ?? []
  const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n")
  const first = msgs.find((m) => m.role === "user")
  const seed = `${system}\n\u0000\n${text(first?.content ?? "")}`
  return createHash("sha256").update(seed).digest("hex").slice(0, 32)
}

// turnEnded says the user spoke: an agent's tool results alone keep the turn.
export function midTurn(body) {
  const msgs = body?.messages ?? []
  const last = [...msgs].reverse().find((m) => m.role !== "system" && m.role !== "developer")
  return last?.role === "tool"
}

export class Pool {
  #store
  #usageOf
  #now
  #state = new Map() // account id → { rest: {until, why}, usage: {at, value}, tokens, at }
  #stick = new Map() // conversation → { id, at }
  #turns = new Map() // pool → count, for rotate
  #log = []
  #logLimit = 500
  identity
  // clientFor is the Qoder client of one account, and the seam a test
  // replaces the network with.
  clientFor

  constructor({ store, clientFor, usageOf, identity = new IdentityCache(), now = () => Date.now() }) {
    this.#store = store
    this.clientFor = clientFor
    this.#usageOf = usageOf
    this.#now = now
    this.identity = identity
  }

  get policy() {
    return this.#store.policy
  }

  #stateOf(id) {
    let s = this.#state.get(id)
    if (!s) {
      s = { rest: null, usage: null, tokens: 0, at: null }
      this.#state.set(id, s)
    }
    return s
  }

  rest(id) {
    const r = this.#stateOf(id).rest
    return r && r.until > this.#now() ? r : null
  }

  resting(id) {
    return Boolean(this.rest(id))
  }

  // noteUsage keeps what the account pages said, so routing reads no network.
  noteUsage(id, usage) {
    this.#stateOf(id).usage = { at: this.#now(), value: usage }
  }

  usage(id) {
    return this.#stateOf(id).usage?.value ?? null
  }

  // served adds what a reply was worth to the account's decaying total.
  served(id, tokens) {
    const s = this.#stateOf(id)
    const now = this.#now()
    const decay = s.at == null ? 0 : 0.5 ** ((now - s.at) / HALF_LIFE)
    s.tokens = s.tokens * decay + (Number(tokens) || 0)
    s.at = now
  }

  // rest puts an account out for the failure's own rest, and says for how long.
  noteFailure(id, failure) {
    const ms = RESTS[failure.kind] ?? RESTS.other
    if (ms > 0) this.#stateOf(id).rest = { until: this.#now() + ms, why: failure.kind, message: failure.message?.slice(0, 300) }
    else this.#stateOf(id).rest = null
    return ms
  }

  clearRest(id) {
    this.#stateOf(id).rest = null
  }

  // refreshUsage reads one account's allowance behind the request, so the
  // UI and the routing see it without waiting.
  async refreshUsage(id) {
    const at = this.#now()
    try {
      const value = await this.#usageOf(id)
      this.#stateOf(id).usage = { at, value }
      return value
    } catch (e) {
      const value = { error: e.message, windows: [] }
      this.#stateOf(id).usage = { at, value }
      return value
    }
  }

  async refreshAll() {
    await Promise.all(this.#store.list().filter((a) => a.enabled && !a.needsLogin).map((a) => this.refreshUsage(a.id)))
    return this.snapshot()
  }

  // stick notes who answered a conversation.
  stick(conversation, id) {
    this.#stick.set(conversation, { id, at: this.#now() })
    if (this.#stick.size > 1024) {
      const now = this.#now()
      for (const [k, v] of this.#stick) if (now - v.at > HELD_FOR) this.#stick.delete(k)
    }
  }

  // held is who answered conversation, while the affinity says to keep it.
  held(conversation) {
    const s = this.#stick.get(conversation)
    if (!s) return null
    const affinity = this.policy.affinity
    if (affinity === "off") return null
    if (this.#now() - s.at > HELD_FOR) return null
    return s.id
  }

  #usable() {
    return this.#store
      .list()
      .filter((a) => a.enabled && !a.needsLogin && !this.resting(a.id))
  }

  // order is the accounts to try, best first, as the routing says.
  order(pool = "qoder") {
    const all = this.#usable()
    if (all.length < 2) return all
    const routing = this.policy.routing
    const seats = all.map((a) => {
      const used = share(this.usage(a.id))
      const known = used != null
      return { a, used: known ? used : 0, known, tokens: this.#stateOf(a.id).tokens }
    })
    if (routing === "rotate") {
      const turn = this.#turns.get(pool) ?? 0
      this.#turns.set(pool, turn + 1)
      const n = turn % seats.length
      return [...seats.slice(n), ...seats.slice(0, n)].map((s) => s.a)
    }
    if (routing === "order") return seats.map((s) => s.a)
    if (routing === "usage") {
      seats.sort((x, y) => x.used - y.used || x.tokens - y.tokens)
      return seats.map((s) => s.a)
    }
    // smart: those with room, by what they have left; then the low ones; then
    // the spent; an account whose allowance isn't known goes after those known
    const tier = (s) => (s.used >= USED_SHARE ? 2 : s.used >= LOW_SHARE ? 1 : 0)
    seats.sort((x, y) => {
      if (x.known !== y.known) return x.known ? -1 : 1
      const tx = tier(x)
      const ty = tier(y)
      if (tx !== ty) return tx - ty
      return x.used - y.used || x.tokens - y.tokens
    })
    return seats.map((s) => s.a)
  }

  // pick is the first account to try, honouring the conversation's affinity,
  // and the ones to fall over to.
  pick(conversation, { mid = false } = {}) {
    const ordered = this.order()
    if (!ordered.length) return { first: null, rest: [] }
    const affinity = this.policy.affinity
    const held = affinity === "off" ? null : this.held(conversation?.id)
    const keep = held && (affinity === "session" || mid) ? ordered.find((a) => a.id === held) : null
    if (keep) return { first: keep, rest: ordered.filter((a) => a.id !== keep.id) }
    return { first: ordered[0], rest: ordered.slice(1) }
  }

  // run sends one request, falling over from an account that refuses it for a
  // reason another account might not, and returns what answered. build makes
  // one account's payload: each account has its own model listing.
  async run({ conversation, signal, build, onTried }) {
    const { first, rest } = this.pick(conversation, { mid: midTurn(conversation?.body) })
    if (!first) {
      const left = this.#store.list()
      const why = !left.length
        ? "no accounts; sign in first"
        : left.filter((a) => a.enabled).every((a) => a.needsLogin)
          ? "every account needs signing in again"
          : "every account is resting"
      throw Object.assign(new Error(why), { status: 503, code: "no_account" })
    }
    let last = null
    for (const account of [first, ...rest]) {
      onTried?.(account.id)
      let built
      try {
        built = await build(account.id)
      } catch (e) {
        // this account can't serve the model; the next may. A lapsed sign-in
        // is the account's own, and is kept as such.
        last = { error: e }
        this.#trace(account.id, "build", e.message)
        if (/sign in again|lapsed|expired/i.test(e.message ?? "")) await this.#store.lapsed(account.id, true)
        continue
      }
      const client = this.clientFor(account.id)
      let upstream
      try {
        upstream = await client.chat(built.payload, signal)
      } catch (e) {
        last = { status: 502, error: e }
        this.noteFailure(account.id, { kind: "network", message: e.message })
        this.#trace(account.id, "network", e.message)
        continue
      }
      if (upstream.ok) {
        // Qoder answers 200 and puts a refusal in the envelope: look at the
        // first frame before the caller sees a 200 it can't use.
        const looked = await peek(upstream.body)
        const refused = refusalOf(looked.frame)
        if (refused) {
          this.noteFailure(account.id, refused)
          this.#trace(account.id, refused.kind, refused.message)
          last = { status: refused.status, failure: refused }
          if (refused.kind === "request") break
          if (refused.kind === "auth") await this.#store.lapsed(account.id, true)
          if (signal?.aborted) break
          continue
        }
        return { account, upstream: { ...upstream, body: looked.body }, client, model: built.model }
      }
      const text = await upstream.text().catch(() => "")
      const failure = describeFailure(upstream.status, text)
      this.noteFailure(account.id, failure)
      this.#trace(account.id, failure.kind, failure.message)
      last = { status: upstream.status, failure }
      // a refusal of the request itself is the caller's: another account
      // would say the same. A lapsed sign-in is this account's, and the
      // next one is tried.
      if (failure.kind === "request") break
      if (failure.kind === "auth") await this.#store.lapsed(account.id, true)
      if (signal?.aborted) break
    }
    const f = last?.failure
    throw Object.assign(new Error(f?.message ?? last?.error?.message ?? "no account answered"), {
      status: f ? (f.status === 401 || f.status === 403 ? 502 : f.status) : last?.error?.status ?? 502,
      code: f?.code || last?.error?.code || "upstream_error",
      kind: f?.kind,
    })
  }

  #trace(account, kind, message) {
    this.#log.push({ at: this.#now(), account, kind, message: String(message ?? "").slice(0, 300) })
    if (this.#log.length > this.#logLimit) this.#log.splice(0, this.#log.length - this.#logLimit)
  }

  trace(limit = 100) {
    return this.#log.slice(-limit).reverse()
  }

  // snapshot is the UI's view: each account, what it has left, whether it
  // rests, and what it served.
  snapshot() {
    return this.#store.list().map((a) => {
      const s = this.#stateOf(a.id)
      const usage = s.usage?.value ?? null
      const rest = this.rest(a.id)
      return {
        id: a.id,
        email: a.creds?.email ?? "",
        name: a.creds?.name ?? "",
        enabled: a.enabled,
        needsLogin: a.needsLogin,
        expires: a.creds?.expires ?? null,
        addedAt: a.addedAt,
        usage: usage ? { at: s.usage.at, plan: usage.plan ?? null, windows: usage.windows ?? [], percent: usage.percent ?? null, error: usage.error ?? null } : null,
        share: share(usage),
        resting: rest ? { until: rest.until, why: rest.why } : null,
        tokens: Math.round(s.tokens),
      }
    })
  }
}
