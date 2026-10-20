// The accounts a pool serves: one store for the sign-ins, and the one
// refresh at a time that a single-use refresh token needs.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { SITES, credentialsPath, loadCredentials, refreshJob } from "./auth.js"

export const STORE_VERSION = 1
// How a pool orders its accounts, as magpie routes a provider's.
export const ROUTINGS = ["smart", "usage", "rotate", "order"]
// How long a conversation stays with the account that answered it.
export const AFFINITIES = ["session", "turn", "off"]

// accountsPath: $QODER_CLIENT_ACCOUNTS, else <data dir>/accounts.json.
export function accountsPath(env = process.env) {
  if (env.QODER_CLIENT_ACCOUNTS) return env.QODER_CLIENT_ACCOUNTS
  if (env.QODER_CLIENT_HOME) return join(env.QODER_CLIENT_HOME, "accounts.json")
  return join(dirname(credentialsPath(env)), "accounts.json")
}

const idOf = (creds) => String(creds.uid || creds.accountId || creds.email || "").trim()

// AccountStore keeps the sign-ins and the policy. Everything that is not a
// sign-in — rest, usage, tokens served — is the pool's, in memory.
export class AccountStore {
  #file
  #site
  #accounts = []
  #policy = { routing: "smart", affinity: "session" }
  #saving = Promise.resolve()
  #refreshing = new Map()

  constructor({ file = accountsPath(), site = SITES.qoder } = {}) {
    this.#file = file
    this.#site = site
  }

  get file() {
    return this.#file
  }

  get policy() {
    return { ...this.#policy }
  }

  // load reads the store, or adopts the single-account file an older version
  // wrote, so an existing sign-in keeps working.
  async load() {
    const text = await readFile(this.#file, "utf8").catch(() => null)
    if (text) {
      let saved
      try {
        saved = JSON.parse(text)
      } catch (e) {
        throw new Error(`${this.#file}: ${e.message}`)
      }
      for (const a of saved?.accounts ?? []) {
        const creds = a?.creds
        if (!idOf(creds ?? {})) continue
        this.#accounts.push({
          id: idOf(creds),
          creds,
          enabled: a.enabled !== false,
          needsLogin: Boolean(a.needsLogin),
          addedAt: a.addedAt ?? Date.now(),
        })
      }
      const p = saved?.policy ?? {}
      if (ROUTINGS.includes(p.routing)) this.#policy.routing = p.routing
      if (AFFINITIES.includes(p.affinity)) this.#policy.affinity = p.affinity
      return this
    }
    const legacy = await loadCredentials(credentialsPath()).catch(() => null)
    if (idOf(legacy ?? {})) {
      this.#accounts.push({ id: idOf(legacy), creds: legacy, enabled: true, needsLogin: false, addedAt: Date.now() })
      await this.save()
    }
    return this
  }

  list() {
    return this.#accounts
  }

  get(id) {
    return this.#accounts.find((a) => a.id === id) ?? null
  }

  creds(id) {
    return this.get(id)?.creds ?? null
  }

  // add upserts by the account's own id: signing in again renews its
  // tokens rather than adding a row beside the lapsed one.
  async add(creds) {
    const id = idOf(creds ?? {})
    if (!id) throw new Error("the sign-in names no account")
    const found = this.get(id)
    if (found) {
      found.creds = { ...found.creds, ...creds }
      found.enabled = true
      found.needsLogin = false
    } else {
      this.#accounts.push({ id, creds, enabled: true, needsLogin: false, addedAt: Date.now() })
    }
    await this.save()
    return this.get(id)
  }

  // update keeps new tokens from a refresh or a rotation.
  async update(id, patch) {
    const a = this.get(id)
    if (!a) return null
    a.creds = { ...a.creds, ...patch }
    await this.save()
    return a
  }

  async setEnabled(id, enabled) {
    const a = this.get(id)
    if (!a) return null
    a.enabled = Boolean(enabled)
    await this.save()
    return a
  }

  async lapsed(id, lapsed = true) {
    const a = this.get(id)
    if (!a) return null
    a.needsLogin = Boolean(lapsed)
    await this.save()
    return a
  }

  async remove(id) {
    const at = this.#accounts.findIndex((a) => a.id === id)
    if (at < 0) return false
    this.#accounts.splice(at, 1)
    await this.save()
    return true
  }

  async setPolicy(patch = {}) {
    if (patch.routing !== undefined) {
      if (!ROUTINGS.includes(patch.routing)) throw new Error(`routing is one of ${ROUTINGS.join(", ")}`)
      this.#policy.routing = patch.routing
    }
    if (patch.affinity !== undefined) {
      if (!AFFINITIES.includes(patch.affinity)) throw new Error(`affinity is one of ${AFFINITIES.join(", ")}`)
      this.#policy.affinity = patch.affinity
    }
    await this.save()
    return this.policy
  }

  // save writes the whole store, one write at a time, 0600.
  save() {
    const body = JSON.stringify(
      {
        version: STORE_VERSION,
        policy: this.#policy,
        accounts: this.#accounts.map((a) => ({
          id: a.id,
          enabled: a.enabled,
          needsLogin: a.needsLogin,
          addedAt: a.addedAt,
          creds: a.creds,
        })),
      },
      null,
      2,
    )
    this.#saving = this.#saving.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true })
      const tmp = `${this.#file}.${process.pid}.tmp`
      await writeFile(tmp, body, { mode: 0o600 })
      await rename(tmp, this.#file)
      await chmod(this.#file, 0o600).catch(() => {})
    })
    return this.#saving
  }

  // refresher is the refresh job of one account, shared: Qoder spends a
  // refresh token once, so concurrent 401s must not each send one.
  refresher(id) {
    return async (stale) => {
      const now = this.creds(id)
      if (!now) throw new Error(`account ${id} is gone`)
      if (now.access && stale?.access && now.access !== stale.access) return now
      const flight = this.#refreshing.get(id)
      if (flight) return await flight
      const job = (async () => {
        try {
          const next = await refreshJob(now, this.#site)
          await this.update(id, { access: next.access, refresh: next.refresh, expires: next.expires })
          await this.lapsed(id, false)
          return this.creds(id)
        } catch (e) {
          if (e.expired) await this.lapsed(id, true)
          throw e
        } finally {
          this.#refreshing.delete(id)
        }
      })()
      this.#refreshing.set(id, job)
      return await job
    }
  }
}
