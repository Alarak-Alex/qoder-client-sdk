#!/usr/bin/env node
// qoder-client — sign in accounts, then serve an OpenAI-compatible API over
// all of them.

import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { exec } from "node:child_process"
import { AccountStore, accountsPath } from "../src/accounts.js"
import { IdentityCache, QoderClient, SITES, createApp, deviceSignIn, importMagpie, patSignIn, readUsage } from "../src/index.js"
import { Pool } from "../src/pool.js"

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] ?? true : fallback
}
const has = (name) => argv.includes(`--${name}`)

const USAGE = `qoder-client <command>

  login [--pat]     add a Qoder account (browser device flow, or a PAT)
  import            add every Qoder account magpie already signed in
  accounts          list the accounts and what each has left
  logout [<id>]     forget one account, or every account
  serve             serve an OpenAI-compatible API over all the accounts
                    --port, --host, --api-key, --admin-key, --model

  --accounts <path>, or $QODER_CLIENT_ACCOUNTS, sets the store (default
  ${accountsPath()}).
`

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  exec(`${cmd} "${url}"`, () => {})
}

const store = () => new AccountStore({ file: flag("accounts", accountsPath()) }).load()

async function cmdLogin() {
  const s = await store()
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    let creds
    if (has("pat")) {
      const pat = (await rl.question("Qoder Personal Access Token: ")).trim()
      if (!pat) throw new Error("no token given")
      creds = await patSignIn(pat, SITES.qoder)
    } else {
      console.log("opening the Qoder sign-in page; authorize this device in the browser")
      creds = await deviceSignIn(SITES.qoder, {
        onUrl: (url) => {
          console.log(`\n${url}\n`)
          openBrowser(url)
        },
      })
    }
    await s.add(creds)
    console.log(`signed in as ${creds.accountId} (${creds.uid})`)
    console.log(`accounts: ${s.file} — ${s.list().length} in all`)
  } finally {
    rl.close()
  }
}

async function cmdImport() {
  const s = await store()
  const r = await importMagpie(s, flag("magpie-auth", undefined) === undefined ? undefined : String(flag("magpie-auth")))
  console.log(`read ${r.read} from ${r.file}`)
  for (const a of r.added) console.log(`  ${a}`)
  console.log(`${s.list().length} accounts in all`)
}

async function cmdAccounts() {
  const s = await store()
  if (!s.list().length) return console.log("no accounts; run: qoder-client login")
  for (const a of s.list()) {
    const [left, right] = [`${a.id}`, a.enabled ? "" : "off"]
    let usage = "usage: -"
    try {
      const u = await readUsage(s, a.id)
      const w = u.windows?.[0]
      usage = w ? `${w.used.toFixed(0)}/${w.total.toFixed(0)} ${w.unit}` : u.plan || "no quota"
    } catch (e) {
      usage = `usage: ${e.message.slice(0, 40)}`
    }
    console.log(`${left.padEnd(34)} ${usage.padEnd(22)} ${right}`)
  }
  const p = s.policy
  console.log(`\nrouting ${p.routing}, affinity ${p.affinity}  (${s.file})`)
}

async function cmdLogout() {
  const s = await store()
  const id = argv[1] && !argv[1].startsWith("-") ? argv[1] : ""
  if (id) {
    console.log((await s.remove(id)) ? `forgot ${id}` : `no account ${id}`)
    return
  }
  for (const a of s.list()) await s.remove(a.id)
  console.log(`forgot every account in ${s.file}`)
}

async function cmdServe() {
  const s = await store()
  if (!s.list().length) {
    console.error("no accounts; run: qoder-client login")
    process.exit(1)
  }
  const identity = new IdentityCache()
  const clients = new Map()
  const clientFor = (id) => {
    let c = clients.get(id)
    if (!c) {
      c = new QoderClient({ credentials: s.creds(id), identity, refreshJob: s.refresher(id) })
      clients.set(id, c)
    }
    return c
  }
  const pool = new Pool({ store: s, clientFor, identity, usageOf: (id) => readUsage(s, id) })
  // what each account has left is read once at start, behind the request
  pool.refreshAll().catch(() => {})

  const apiKey = flag("api-key", process.env.QODER_CLIENT_API_KEY || "") || undefined
  const adminKey = flag("admin-key", process.env.QODER_CLIENT_ADMIN_KEY || "") || undefined
  const port = Number(flag("port", 8787))
  const host = String(flag("host", "127.0.0.1"))
  const app = createApp({ pool, store: s, apiKey, adminKey, defaultModel: flag("model", "") || undefined })
  await new Promise((resolve, reject) => {
    app.once("error", reject)
    app.listen(port, host, resolve)
  })
  console.log(`qoder-client serving on http://${host}:${port}`)
  console.log(`  accounts  ${s.list().length} (${s.list().filter((a) => a.enabled).length} on), routing ${s.policy.routing}, affinity ${s.policy.affinity}`)
  console.log(`  openai    http://${host}:${port}/v1${apiKey ? "  (bearer key required)" : ""}`)
  console.log(`  web ui    http://${host}:${port}/${adminKey ? "  (admin key required)" : ""}`)
}

async function main() {
  const cmd = argv[0] ?? "serve"
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return console.log(USAGE)
  switch (cmd) {
    case "login":
      return cmdLogin()
    case "import":
      return cmdImport()
    case "accounts":
      return cmdAccounts()
    case "logout":
      return cmdLogout()
    case "serve":
      return cmdServe()
    default:
      console.log(USAGE)
      process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
