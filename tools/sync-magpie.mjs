#!/usr/bin/env node
// Copy the Qoder sign-ins magpie already has on this machine into a magpie
// data directory — the one a container mounts at /config.
//
// magpie keeps a plugin account's tokens in plugin-auth.json, keyed
// "qoder" and "qoder#<hash>"; logins.json lists the accounts but holds no
// tokens for a plugin's. Both travel, or the container sees accounts with
// nothing to sign in with.
//
//   node tools/sync-magpie.mjs --to ./magpie-config
//   node tools/sync-magpie.mjs --to ./magpie-config --all   # every provider
//
// The files it writes carry secrets: it makes the target 0700 and the files
// 0600, and refuses to write into a directory that is world-readable.

import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(`--${name}`)

const source = resolve(flag("from") ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie"))
const target = flag("to")
if (!target) {
  console.error("usage: sync-magpie.mjs --to <magpie data dir> [--from <config dir>] [--all] [--dry-run]")
  process.exit(2)
}
const to = resolve(target)
const dry = has("dry-run")
const allProviders = has("all")

// The files a container needs. magpie's own state that is rebuilt at runtime
// (routing logs, quota history, affinity, served) stays behind.
const FILES = ["plugins.json", "plugins.yml", "providers.json", "settings.json", "logins.json", "plugin-auth.json", "plugin-providers.json"]
// A plugin's account list lives in these; the tokens live in plugin-auth.json.
const ACCOUNT_FILES = new Set(["logins.json", "plugin-auth.json", "plugin-providers.json"])

const read = async (name) => {
  try {
    return JSON.parse(await readFile(join(source, name), "utf8"))
  } catch {
    return null
  }
}

const qoderKeys = (auth) => Object.keys(auth ?? {}).filter((k) => /^qoder(#|$)/.test(k))

// keepQoder narrows the account files to Qoder, so a machine that has other
// subscriptions doesn't get them copied along.
function keepQoder(name, value) {
  if (!value || allProviders || !ACCOUNT_FILES.has(name)) return value
  if (name === "plugin-auth.json") {
    const out = {}
    for (const [k, v] of Object.entries(value)) if (/^qoder(#|$)/.test(k)) out[k] = v
    return out
  }
  if (name === "logins.json" && Array.isArray(value)) return value.filter((l) => String(l?.agent ?? "").includes("qoder"))
  if (name === "plugin-providers.json" && Array.isArray(value)) return value.filter((p) => /qoder/i.test(String(p?.id ?? p?.name ?? "")))
  return value
}

// providers.json keeps each provider's routing; only Qoder's is wanted.
function keepQoderProviders(value) {
  if (!value || allProviders || !Array.isArray(value.providers)) return value
  return { ...value, providers: value.providers.filter((p) => /qoder/i.test(String(p?.id ?? ""))) }
}

async function main() {
  const auth = await read("plugin-auth.json")
  if (!auth) {
    console.error(`${join(source, "plugin-auth.json")} is missing: sign in to Qoder in magpie first`)
    process.exit(1)
  }
  const keys = qoderKeys(auth)
  if (!keys.length) {
    console.error("no Qoder account in magpie's plugin-auth.json; sign in first")
    process.exit(1)
  }

  // the accounts, without their tokens
  const shown = keys.map((k) => ({
    key: k,
    email: auth[k]?.email || auth[k]?.accountId || "?",
    uid: auth[k]?.uid ?? "?",
    expires: auth[k]?.expires ? new Date(auth[k].expires).toISOString() : "-",
    device: Boolean(auth[k]?.deviceToken),
  }))

  console.log(`from   ${source}`)
  console.log(`to     ${to}${dry ? "  (dry run, nothing written)" : ""}`)
  console.log(`\n${shown.length} Qoder account(s):`)
  for (const a of shown) console.log(`  ${a.email.padEnd(26)} ${a.uid}  expires ${a.expires}${a.device ? "  +device" : ""}`)
  if (!allProviders) console.log("\nother providers are left behind; --all copies them too")

  const plan = []
  for (const name of FILES) {
    let value = await read(name)
    if (value === null) continue
    value = keepQoder(name, value)
    if (name === "providers.json") value = keepQoderProviders(value)
    // an empty account list would erase what the target has: skip it instead
    if (ACCOUNT_FILES.has(name) && (!value || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Object.keys(value).length))) {
      console.log(`  skip ${name}: nothing to carry`)
      continue
    }
    plan.push({ name, value })
  }

  // The daily check-in asks Qoder's own device helper, which ships only with
  // the desktop app and the CLI: in a container it fails on every account,
  // every day, and earns nothing the plugin can't earn in the app. Off.
  const settings = plan.find((p) => p.name === "settings.json")
  if (settings) {
    settings.value = { ...settings.value, pluginCheckins: { ...(settings.value.pluginCheckins ?? {}), qoder: false } }
    console.log("  off   settings.json: qoder pluginCheckins (no device helper in a container)")
  }

  // plugins.json must name the Qoder plugin, or the container has no provider
  const plugins = plan.find((p) => p.name === "plugins.json")
  if (plugins) {
    const list = plugins.value.plugins ?? []
    if (!list.some((p) => /qoder/.test(String(p?.spec ?? "")))) {
      list.push({ spec: "@magpie-community/opencode-qoder-auth@latest" })
      plugins.value = { ...plugins.value, plugins: list }
      console.log("  add   plugins.json: @magpie-community/opencode-qoder-auth@latest")
    }
  }

  // The plugin's own code: magpie loads it from
  // <config>/magpie/plugins/node_modules. Copying it means the container
  // needs no npm registry, which a server behind a firewall often lacks.
  const pluginsDir = join(source, "plugins")
  const hasPlugins = await stat(join(pluginsDir, "node_modules")).then((s) => s.isDirectory()).catch(() => false)
  console.log(`\n${plan.length} file(s) to write${hasPlugins ? ", and the plugin's code" : ""}:`)
  for (const p of plan) console.log(`  ${p.name.padEnd(24)} ${Buffer.byteLength(JSON.stringify(p.value, null, 2))} bytes`)
  if (dry) return

  await mkdir(to, { recursive: true, mode: 0o700 })
  const st = await stat(to)
  if (st.mode & 0o007) {
    console.error(`\n${to} is world-readable; chmod 700 it first: the files carry sign-ins`)
    process.exit(1)
  }
  const dest = join(to, "magpie")
  await mkdir(dest, { recursive: true, mode: 0o700 })
  for (const p of plan) {
    const path = join(dest, p.name)
    await writeFile(path, JSON.stringify(p.value, null, 2) + "\n", { mode: 0o600 })
  }
  console.log(`\nwrote ${plan.length} file(s) into ${dest}`)

  if (hasPlugins) {
    const dst = join(dest, "plugins")
    await cp(pluginsDir, dst, { recursive: true, force: true, dereference: true, filter: (src) => !src.endsWith(".lock") })
    console.log(`copied the plugin's code into ${dst}`)
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
