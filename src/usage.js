// The account's allowance, as Qoder's own account pages tell it: the day's
// credits among them. Needed to route by what is left rather than by guess.

import { SITES } from "./auth.js"

const TIMEOUT = 20_000

const api = (creds, site) => (creds?.site === "qoder-cn" ? SITES["qoder-cn"] : site)

async function get(site, path, token) {
  const res = await fetch(site.openapi + path, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Cosy-ClientType": "10", "User-Agent": "Qoder" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  return res
}

// deviceRefresh trades the device token's refresh token for a new pair. It
// is spent once, so callers save it.
export async function deviceRefresh(site, refreshToken) {
  const refresh = String(refreshToken ?? "").trim()
  if (!refresh) throw new Error("the account has no device refresh token; sign in again")
  const res = await fetch(site.openapi + "/api/v1/deviceToken/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (res.status !== 200) throw Object.assign(new Error(`device token refresh: HTTP ${res.status}`), { expired: [401, 403].includes(res.status) })
  const j = await res.json().catch(() => ({}))
  const next = j.token || j.device_token || ""
  if (!String(next).trim() || !String(j.refresh_token ?? "").trim()) throw new Error("device token refresh: incomplete pair")
  return { deviceToken: next, deviceRefresh: j.refresh_token }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const pick = (o, a, b) => (o?.[a] !== undefined ? o[a] : o?.[b])

// parseUsage turns the envelope into windows of used/total credits, plus the
// account's own percentage. isQuotaExceeded is left alone: it was true for an
// account that answered and false for one that was out.
export function parseUsage(env) {
  if (env?.displayMode === "enterprise") return { plan: "Enterprise", windows: [] }
  const u = env?.qoderUsage
  if (!u || typeof u !== "object" || Array.isArray(u)) return { error: "missing quota data", windows: [] }
  const out = { windows: [] }
  if (typeof pick(u, "userType", "user_type") === "string") out.plan = pick(u, "userType", "user_type")
  const add = (b, name) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return
    const total = num(b.total) ?? num(b.cap)
    const used = num(b.used) ?? (num(b.remaining) != null ? total - num(b.remaining) : undefined)
    if (!(total > 0) || used == null || used < 0) return
    out.windows.push({
      name: b.name || name,
      used,
      total,
      unit: b.unit || "credits",
      share: Math.min(100, (100 * used) / total),
    })
  }
  add(pick(u, "userQuota", "user_quota"), "Credits")
  add(pick(u, "addOnQuota", "add_on_quota"), "Add-on credits")
  add(pick(u, "orgResourcePackage", "org_resource_package"), "Shared credits")
  const dedicated = pick(u, "dedicatedResourcePackages", "dedicated_resource_packages")
  for (const b of Array.isArray(dedicated) ? dedicated : []) add(b, "Dedicated credits")
  const pct = num(pick(u, "totalUsagePercentage", "total_usage_percentage"))
  if (pct != null) out.percent = Math.min(100, Math.max(0, pct))
  return out
}

// usage reads one account's allowance. A refused device token is renewed once
// and the caller told what to save.
export async function readUsage(store, id, site = SITES.qoder) {
  const creds = store.creds(id)
  if (!creds) throw new Error(`account ${id} is gone`)
  const s = api(creds, site)
  const token = creds.deviceToken || creds.access
  if (!token) throw new Error("the account has no token to read usage with")
  let res = await get(s, "/sash/api/v2/me/usage", token)
  if (res.status === 401 || res.status === 403) {
    if (!creds.deviceToken) throw Object.assign(new Error("usage: refused"), { status: res.status })
    const next = await deviceRefresh(s, creds.deviceRefresh).catch(() => null)
    if (!next) throw Object.assign(new Error("usage: refused"), { status: res.status })
    await store.update(id, next)
    res = await get(s, "/sash/api/v2/me/usage", next.deviceToken)
  }
  if (res.status !== 200) throw Object.assign(new Error(`usage: HTTP ${res.status}`), { status: res.status })
  const env = await res.json().catch(() => null)
  return parseUsage(env)
}
