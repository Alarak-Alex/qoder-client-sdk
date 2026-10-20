// Taking the Qoder accounts magpie already signed in, so a pool starts with
// the sign-ins that are already there rather than asking for each again.

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// magpieAuthPath is where magpie keeps a plugin's accounts: its config
// directory, beside logins.json.
export function magpieAuthPath({ home = homedir(), env = process.env } = {}) {
  const dir = env.MAGPIE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "magpie")
  return join(dir, "plugin-auth.json")
}

// magpieAccounts reads Qoder's entries out of magpie's plugin-auth.json. It
// keys them "qoder" and "qoder#<hash>"; anything else is another provider's.
export async function magpieAccounts(file = magpieAuthPath()) {
  const saved = JSON.parse(await readFile(file, "utf8"))
  const out = []
  for (const [key, v] of Object.entries(saved ?? {})) {
    if (!/^qoder(#|$)/.test(key)) continue
    if (v?.type && v.type !== "oauth") continue
    if (!v?.uid || !v?.access) continue
    out.push({
      site: "qoder",
      access: v.access,
      refresh: v.refresh ?? "",
      expires: Number(v.expires) || 0,
      accountId: v.accountId || v.email || v.uid,
      uid: v.uid,
      email: v.email ?? "",
      name: v.name ?? "",
      machineId: v.machineId || "",
      deviceToken: v.deviceToken ?? "",
      deviceRefresh: v.deviceRefresh ?? "",
    })
  }
  return out
}

// importMagpie adds every Qoder account magpie holds, and says how many were
// read and how many the store took.
export async function importMagpie(store, file = magpieAuthPath()) {
  const accounts = await magpieAccounts(file)
  for (const creds of accounts) await store.add(creds)
  return { file, read: accounts.length, added: accounts.map((a) => a.accountId) }
}
