// Qoder's native device identity: the helper its client ships generates a
// machine token bound to the signed-in account. The token is what makes a
// call look like it came from a client rather than a script.

import { execFile } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const TTL = 60 * 60 * 1000 // the desktop client renews its identity hourly

// identityRuntime locates the helper: env override, the desktop app's bundled
// copy, then the CLI's cached copy under <config>/.bin.
export async function identityRuntime({ home = homedir(), platform = process.platform, arch = process.arch, env = process.env, opt = "/opt" } = {}) {
  if (env.QODER_RUNTIME_INFO) return resolve(env.QODER_RUNTIME_INFO)
  const name = platform === "win32" ? "runtime-info.exe" : "runtime-info"
  const isFile = async (p) => (await stat(p).catch(() => null))?.isFile() ?? false
  const paths = []
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local")
    paths.push(join(local, "Programs", "Qoder", "resources", "umid", name))
  } else if (platform === "darwin") {
    for (const dir of ["/Applications", join(home, "Applications")]) paths.push(join(dir, "Qoder.app", "Contents", "Resources", "umid", name))
  } else if (platform === "linux") {
    paths.push(join(opt, "Qoder", "resources", "umid", name))
  }
  for (const p of paths) if (await isFile(p)) return p
  const config = env.QODER_CONFIG_DIR || join(env.QODER_CLI_HOME || home, env.QODER_CONFIG_DIR_NAME || ".qoder")
  const cache = join(config, ".bin")
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const d of entries) {
    let p
    if (platform === "win32") {
      if (d.isDirectory() && d.name.startsWith(`umid-win32-${arch}-`)) p = join(cache, d.name, name)
    } else if (d.isFile() && d.name.startsWith(`runtime-info-${platform}-${arch}-`) && !d.name.endsWith(".tmp")) {
      p = join(cache, d.name)
    }
    if (p && (await isFile(p))) found.push({ path: p, time: (await stat(p)).mtimeMs })
  }
  if (found.length) return found.sort((a, b) => b.time - a.time)[0].path
  return null
}

// ENVIRONMENT is the product whose identity the helper reports. Its argument
// picks the environment, and each one yields a different machine token: 4 is
// the desktop app (the pair in ~/.qoder/umid-cache.json and in the app's own
// traffic), 3 is the CLI, 1 is empty. Passing 3 while claiming to be the
// desktop client sends an identity the app never uses.
export const ENVIRONMENT = { cli: 3, app: 4 }

// readIdentity runs the helper: { machineToken, machineType, machineCode,
// vmInfo }. The token is per machine and environment, not per account; uid is
// still handed over because the helper accepts it.
export async function readIdentity(uid, { env = ENVIRONMENT.app, ...opts } = {}) {
  const file = await identityRuntime(opts)
  if (!file) throw new Error("Qoder's identity helper wasn't found; install Qoder desktop, sign in to the Qoder CLI once, or set QODER_RUNTIME_INFO")
  const args = process.platform === "linux" ? [String(env)] : [String(env), "--account-stdin"]
  const out = await new Promise((res, rej) => {
    const child = execFile(file, args, { timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => (err ? rej(err) : res(stdout)))
    child.stdin?.on("error", () => {})
    child.stdin?.end(process.platform === "linux" ? undefined : JSON.stringify({ account: uid ?? "" }) + "\n")
  })
  const line = out.split(/\r?\n/).find((l) => l.trim().startsWith("{"))
  if (!line) throw new Error("the identity helper returned nothing usable")
  const identity = JSON.parse(line)
  const clean = (v) => {
    const s = String(v ?? "").trim()
    return s && s.length <= 4096 && /^[\x20-\x7e]+$/.test(s) ? s : ""
  }
  const machineToken = clean(identity?.machineToken)
  const machineType = clean(identity?.machineType)
  if (!machineToken || !machineType) throw new Error("the identity helper returned an unusable identity")
  return { machineToken, machineType, machineCode: clean(identity?.machineCode), vmInfo: identity?.vmInfo ?? null, environment: env }
}

// IdentityCache keeps one read per uid for an hour, sharing an in-flight read
// and leaving a failed one available for the next attempt.
export class IdentityCache {
  #entries = new Map()
  constructor({ ttl = TTL, read = readIdentity } = {}) {
    this.ttl = ttl
    this.read = read
  }
  async get(uid) {
    const now = Date.now()
    let e = this.#entries.get(uid)
    if (!e || now - e.at >= this.ttl) {
      e = { at: now, promise: this.read(uid) }
      this.#entries.set(uid, e)
    }
    try {
      return await e.promise
    } catch (err) {
      if (this.#entries.get(uid) === e) this.#entries.delete(uid)
      throw err
    }
  }
}
