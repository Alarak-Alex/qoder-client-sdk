// The wire format of Qoder's own client: the COSY envelope on every call and
// the codec its request bodies travel in.
//
// Recovered from the shipped client (Qoder 0.4.8, qoder-worker-runtime
// 1.1.69) and checked against traffic the client itself sent.

import { createCipheriv, createHash, constants, publicEncrypt, randomUUID } from "node:crypto"

// The RSA key Qoder's desktop client embeds. It wraps the per-request AES key
// of the envelope; the private half lives on the server.
const RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

// COSY_VERSION is the client build the envelope claims. It tracks the shipped
// worker (runtime-info.json: version 1.1.69); a stale value is the first thing
// that looks unlike the client.
export const COSY_VERSION = "1.1.69"
export const CLIENT_TYPE = "10"

const hexID = () => randomUUID().replaceAll("-", "")

const machineOS = (arch = process.arch, platform = process.platform) => {
  const a = { x64: "x86_64", ia32: "x86", arm64: "aarch64" }[arch] ?? arch
  return `${a}_${platform}`
}

// userBlob is the account as the envelope carries it: AES-128-CBC under a
// fresh key that is its own IV, the key wrapped with Qoder's RSA key.
export function userBlob(u) {
  const raw = JSON.stringify({
    uid: u.uid,
    aid: "",
    name: u.name ?? "",
    email: u.email ?? "",
    security_oauth_token: u.access,
  })
  const key = Buffer.from(hexID().slice(0, 16))
  const c = createCipheriv("aes-128-cbc", key, key)
  const info = Buffer.concat([c.update(raw, "utf8"), c.final()]).toString("base64")
  const wrapped = publicEncrypt({ key: RSA_KEY, padding: constants.RSA_PKCS1_PADDING }, key).toString("base64")
  return { info, key: wrapped }
}

// cosyHeaders signs a call to url whose body, in its wire form, is body.
//
// identity is the account's native device identity ({ machineToken,
// machineType }) as the client's own helper reports it. Without one the
// envelope falls back to the machine id, which is a shape no client sends and
// is the most visible way a third-party caller gives itself away.
export function cosyHeaders(url, u, body, { ts = Math.floor(Date.now() / 1000), identity } = {}) {
  if (!u?.machineId) throw new Error("the account has no machine id; sign in again")
  const blob = userBlob(u)
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: hexID(), info: blob.info, cosyVersion: COSY_VERSION, ideVersion: "" }),
  ).toString("base64")
  const parsed = new URL(url)
  let path = parsed.pathname
  const algo = path.startsWith("/algo")
  if (algo) path = path.slice(5)
  const sig = createHash("md5").update(`${payload}\n${blob.key}\n${ts}\n${body}\n${path}`).digest("hex")
  const m = u.machineId
  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": "app",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientType": CLIENT_TYPE,
    "Cosy-Data-Policy": u.dataPolicy ?? "disagree",
    "Cosy-Date": String(ts),
    "Cosy-Key": blob.key,
    "Cosy-MachineId": m,
    "Cosy-MachineOS": machineOS(),
    "Cosy-Scene": "app",
    "Cosy-User": u.uid,
    "Cosy-Version": COSY_VERSION,
    "Login-Version": "v2",
  }
  headers["Cosy-MachineToken"] = identity?.machineToken || m
  headers["Cosy-MachineType"] = identity?.machineType || "5"
  // the /algo endpoints don't carry Cosy-ClientIp; the rest do
  if (!algo) headers["Cosy-ClientIp"] = m
  return headers
}

// ---- the body codec -----------------------------------------------------------

// Base64 through the client's shuffled alphabet ('$' pads), then the first
// and last thirds swapped.
export const ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"

export function segmentEncode(bytes) {
  let s = ""
  let acc = 0
  let nb = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff
    nb += 8
    while (nb >= 6) {
      nb -= 6
      s += ALPHABET[(acc >> nb) & 63]
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63]
  while (s.length % 4) s += "$"
  return s
}

export function swapThirds(s) {
  const t = Math.floor(s.length / 3)
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s
}

export const encodeBody = (text) => swapThirds(segmentEncode(Buffer.from(text, "utf8")))

export function decodeBody(wire) {
  const s = swapThirds(wire)
  const out = []
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== "$").map((c) => ALPHABET.indexOf(c))
    let x = 0
    for (const v of vals) x = x * 64 + v
    const n = Math.floor((6 * vals.length) / 8)
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255)
  }
  return Buffer.from(out).toString("utf8")
}
