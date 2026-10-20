#!/usr/bin/env node
// qoder-client — sign in, then serve an OpenAI-compatible API.

import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { exec } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import {
  IdentityCache,
  QoderClient,
  SITES,
  createApp,
  credentialsPath,
  deviceSignIn,
  loadCredentials,
  refreshJob,
  saveCredentials,
} from "../src/index.js"

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] ?? true : fallback
}
const has = (name) => argv.includes(`--${name}`)

const USAGE = `qoder-client <command>

  login [--pat]     sign in to Qoder (browser device flow, or a Personal Access Token)
  logout            forget the saved sign-in
  whoami            print the signed-in account
  models            list the account's models
  serve             serve an OpenAI-compatible API on 127.0.0.1:8787
                    --port, --host, --api-key, --model

  Every command takes --credentials <path>. QODER_CLIENT_CREDENTIALS sets it too.
`

// credentialsFile is --credentials, else $QODER_CLIENT_CREDENTIALS, else the
// default under the config directory.
const credentialsFile = () => flag("credentials", credentialsPath())

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  exec(`${cmd} "${url}"`, () => {})
}

async function ensureCredentials() {
  const creds = await loadCredentials(credentialsFile())
  if (!creds) {
    console.error("not signed in; run: qoder-client login")
    process.exit(1)
  }
  return creds
}

function makeClient(creds) {
  return new QoderClient({
    credentials: creds,
    identity: new IdentityCache(),
    refreshJob,
    onCredentials: async (next) => {
      await saveCredentials(next, credentialsFile())
    },
  })
}

async function cmdLogin() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    if (has("pat")) {
      const pat = (await rl.question("Qoder Personal Access Token: ")).trim()
      if (!pat) throw new Error("no token given")
      const { patSignIn } = await import("../src/auth.js")
      const creds = await patSignIn(pat, SITES.qoder)
      const file = await saveCredentials(creds, credentialsFile())
      console.log(`signed in as ${creds.accountId} (${creds.uid})`)
      console.log(`credentials: ${file}`)
      return
    }
    console.log("opening the Qoder sign-in page; authorize this device in the browser")
    const creds = await deviceSignIn(SITES.qoder, {
      onUrl: (url) => {
        console.log(`\n${url}\n`)
        openBrowser(url)
      },
    })
    const file = await saveCredentials(creds, credentialsFile())
    console.log(`\nsigned in as ${creds.accountId} (${creds.uid})`)
    console.log(`credentials: ${file}`)
  } finally {
    rl.close()
  }
}

async function cmdWhoami() {
  const creds = await ensureCredentials()
  console.log(`account   ${creds.accountId}`)
  console.log(`uid       ${creds.uid}`)
  console.log(`email     ${creds.email || "-"}`)
  console.log(`machineId ${creds.machineId}`)
  console.log(`expires   ${new Date(creds.expires).toISOString()}`)
}

async function cmdModels() {
  const client = makeClient(await ensureCredentials())
  const listing = await client.models()
  const { normalizeModels } = await import("../src/client.js")
  const list = normalizeModels(listing, "chat")
  for (const m of list) {
    const tags = [m.reasoning ? "reasoning" : "", m.image ? "image" : ""].filter(Boolean).join(",")
    console.log(`${m.key.padEnd(22)} ${m.name.padEnd(24)} ${String(m.context).padStart(9)}  ${tags}`)
  }
  console.log(`\n${list.length} models`)
}

async function cmdServe() {
  const creds = await ensureCredentials()
  const client = makeClient(creds)
  const port = Number(flag("port", 8787))
  const host = String(flag("host", "127.0.0.1"))
  const apiKey = flag("api-key", process.env.QODER_CLIENT_API_KEY || "")
  const model = flag("model", "")
  const app = createApp({ client, apiKey: apiKey || undefined, defaultModel: model || undefined })
  await new Promise((resolve, reject) => {
    app.once("error", reject)
    app.listen(port, host, resolve)
  })
  console.log(`qoder-client serving on http://${host}:${port}`)
  console.log(`  account ${creds.accountId}`)
  console.log(`  openai base_url http://${host}:${port}/v1${apiKey ? "  (bearer key required)" : ""}`)
}

async function main() {
  const cmd = argv[0] ?? "serve"
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return console.log(USAGE)
  switch (cmd) {
    case "login":
      return cmdLogin()
    case "logout": {
      const { unlink } = await import("node:fs/promises")
      await unlink(credentialsFile()).catch(() => {})
      return console.log(`forgot ${credentialsFile()}`)
    }
    case "whoami":
      return cmdWhoami()
    case "models":
      return cmdModels()
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
