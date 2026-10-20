// Sign-in and credential storage.
//
// The browser device flow Qoder's client uses: a PKCE challenge and a machine
// id go to the account picker, the same nonce is polled for a device token,
// and the device token buys the job token that signs chat calls.

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const SITES = {
  qoder: {
    id: "qoder",
    name: "Qoder",
    clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    web: "https://qoder.com",
    openapi: "https://openapi.qoder.sh",
    api: "https://api3.qoder.sh",
    redirect: "qoder-app://",
  },
}

const SIGN_IN_TIMEOUT = 15 * 60 * 1000
const b64url = (b) => b.toString("base64url")
const DAY = 24 * 60 * 60 * 1000

// credentialsPath: $QODER_CLIENT_CREDENTIALS, else ~/.config/qoder-client/credentials.json
export function credentialsPath(env = process.env) {
  return env.QODER_CLIENT_CREDENTIALS || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qoder-client", "credentials.json")
}

export async function loadCredentials(file = credentialsPath()) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return null
  }
}

export async function saveCredentials(creds, file = credentialsPath()) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => {})
  return file
}

async function openapi(site, path, { method = "GET", token, body, query } = {}) {
  const url = new URL(site.openapi + path)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  const headers = { Accept: "application/json" }
  if (body) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

const jobExpiry = (jt) => Date.now() + (jt?.expires_in > 0 ? jt.expires_in : DAY)

// deviceSignIn runs the browser device flow and returns the account.
export async function deviceSignIn(site = SITES.qoder, { onUrl, pollMs = 2000, timeout = SIGN_IN_TIMEOUT } = {}) {
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  const nonce = randomUUID()
  const machineId = randomUUID()
  const q = new URLSearchParams({ challenge, challenge_method: "S256", nonce, machine_id: machineId, client_id: site.clientId })
  if (site.redirect) q.set("redirect_uri", site.redirect)
  const url = `${site.web}/device/selectAccounts?${q}`
  onUrl?.(url)

  const until = Date.now() + timeout
  let dt
  for (;;) {
    if (Date.now() > until) throw new Error(`${site.name}: the sign-in timed out; start again`)
    try {
      const r = await openapi(site, "/api/v1/deviceToken/poll", { query: { nonce, verifier, challenge_method: "S256" } })
      if (r.status === 200 && String(r.json?.token ?? "").trim()) {
        dt = r.json
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, pollMs))
  }

  const jr = await openapi(site, "/api/v1/me/jobToken", { method: "POST", token: dt.token, body: { clientId: site.clientId } })
  if (jr.status !== 200 || !String(jr.json?.token ?? "").trim()) {
    throw new Error(`${site.name} job token: status ${jr.status}: ${jr.text.trim().slice(0, 300)}`)
  }

  let email = ""
  let name = ""
  let uid = dt.user_id
  const ui = await openapi(site, "/api/v1/userinfo", { token: dt.token }).catch(() => null)
  if (ui && ui.status >= 200 && ui.status < 300) {
    email = ui.json?.email ?? ""
    name = ui.json?.name ?? ""
    uid = uid || String(ui.json?.id ?? ui.json?.user_id ?? ui.json?.uid ?? "")
  }
  return {
    site: site.id,
    access: jr.json.token,
    refresh: jr.json.refresh_token ?? "",
    expires: jobExpiry(jr.json),
    accountId: email || String(uid ?? ""),
    uid: String(uid ?? ""),
    email,
    name: name || dt.user_name || "",
    machineId,
    deviceToken: dt.token,
    deviceRefresh: dt.refresh_token ?? "",
  }
}

// patSignIn exchanges a Personal Access Token for a job token, skipping the
// browser: PATs last up to a year, so a lapsed job token is renewed from it.
export async function patSignIn(pat, site = SITES.qoder) {
  const r = await openapi(site, "/api/v1/jobToken/exchange", { method: "POST", body: { personal_token: pat } })
  if ([400, 401, 403].includes(r.status)) throw new Error(`${site.name} refused the PAT; check it is still valid`)
  if (r.status !== 200) throw new Error(`${site.name} PAT exchange: status ${r.status}`)
  const token = String(r.json?.token ?? r.json?.device_token ?? r.json?.access_token ?? "").trim()
  if (!token) throw new Error(`${site.name} PAT exchange: empty token`)
  let uid = ""
  let email = ""
  let name = ""
  const ui = await openapi(site, "/api/v1/userinfo", { token }).catch(() => null)
  if (ui && ui.status >= 200 && ui.status < 300) {
    email = ui.json?.email ?? ""
    name = ui.json?.name ?? ""
    uid = String(ui.json?.id ?? ui.json?.user_id ?? ui.json?.uid ?? "")
  }
  if (!uid) throw new Error(`${site.name} PAT sign-in: could not determine the user id`)
  return {
    site: site.id,
    access: token,
    refresh: String(r.json?.refresh_token ?? "").trim(),
    expires: Date.now() + (r.json?.expires_in > 0 ? r.json.expires_in : DAY),
    accountId: email || uid,
    uid,
    email,
    name,
    machineId: randomUUID(),
    deviceToken: "",
    deviceRefresh: "",
    pat,
  }
}

// refreshJob trades the job token's refresh token for a new pair; the old one
// is spent.
export async function refreshJob(creds, site = SITES.qoder) {
  if (!String(creds.refresh ?? "").trim()) throw new Error("the sign-in lapsed; sign in again")
  const r = await openapi(site, "/api/v1/jobToken/refresh", { method: "POST", body: { refresh_token: creds.refresh } })
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("the sign-in has expired; sign in again"), { expired: true })
  if (r.status !== 200) throw new Error(`job token refresh: status ${r.status}`)
  if (!String(r.json?.token ?? "").trim() || !String(r.json?.refresh_token ?? "").trim()) throw new Error("job token refresh: incomplete pair")
  return { ...creds, access: r.json.token, refresh: r.json.refresh_token, expires: jobExpiry(r.json) }
}
