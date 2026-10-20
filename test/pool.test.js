// The pool's routing, rest and affinity, and the allowance parse — offline,
// with a fake account store and fake Qoder clients.

import assert from "node:assert/strict"
import { Readable } from "node:stream"
import { test } from "node:test"

import { Pool, conversationOf, midTurn, RESTS } from "../src/pool.js"
import { parseUsage } from "../src/usage.js"

const creds = (id) => ({ uid: id, accountId: id, email: `${id}@x`, access: `jt-${id}`, machineId: `m-${id}` })

function fakeStore(ids, policy = { routing: "smart", affinity: "session" }) {
  const rows = ids.map((id) => ({ id, creds: creds(id), enabled: true, needsLogin: false, addedAt: 0 }))
  const lapsed = []
  return {
    list: () => rows,
    get: (id) => rows.find((r) => r.id === id) ?? null,
    creds: (id) => rows.find((r) => r.id === id)?.creds ?? null,
    policy,
    lapsed: async (id, on) => {
      lapsed.push([id, on])
      return null
    },
    lapsedCalls: lapsed,
  }
}

// stream is one chat completion answering `text`, with usage.
const answer = (text, tokens = 10) => {
  const sse = [
    `data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"${text}\\"},\\"index\\":0,\\"finish_reason\\":\\"stop\\"}],\\"usage\\":{\\"prompt_tokens\\":${tokens},\\"completion_tokens\\":1,\\"total_tokens\\":${tokens + 1}}}"}`,
    "",
  ].join("\n")
  return Readable.from([Buffer.from(sse)])
}

const refuse = (status, body) => ({ ok: false, status, text: async () => body })

function fakeClients(plan) {
  const calls = []
  return {
    calls,
    clientFor: (id) => ({
      chat: async (payload) => {
        calls.push([id, payload?.business?.name])
        const reply = plan[id]
        const next = typeof reply === "function" ? reply(calls.filter((c) => c[0] === id).length) : reply
        return next
      },
    }),
  }
}

const pool = ({ store, clients, now }) =>
  new Pool({ store, clientFor: clients.clientFor, usageOf: async () => ({ windows: [] }), now })

test("smart puts the account with the most left first, the spent last", () => {
  const store = fakeStore(["a", "b", "c"])
  const p = pool({ store, clients: fakeClients({}) })
  p.noteUsage("a", { windows: [{ share: 95 }] })
  p.noteUsage("b", { windows: [{ share: 10 }] })
  p.noteUsage("c", { windows: [{ share: 100 }] })
  assert.deepEqual(p.order().map((a) => a.id), ["b", "a", "c"])
})

test("an account whose allowance is unknown goes after those known", () => {
  const store = fakeStore(["a", "b"])
  const p = pool({ store, clients: fakeClients({}) })
  p.noteUsage("b", { windows: [{ share: 50 }] })
  assert.deepEqual(p.order().map((a) => a.id), ["b", "a"])
})

test("usage routing takes the least used, rotate goes round", () => {
  const store = fakeStore(["a", "b"])
  const p = pool({ store, clients: fakeClients({}) })
  p.noteUsage("a", { windows: [{ share: 80 }] })
  p.noteUsage("b", { windows: [{ share: 5 }] })
  store.policy.routing = "usage"
  assert.deepEqual(p.order().map((a) => a.id), ["b", "a"])
  store.policy.routing = "rotate"
  const first = p.order().map((a) => a.id)
  const second = p.order().map((a) => a.id)
  assert.deepEqual([first, second], [["a", "b"], ["b", "a"]])
})

test("a failed account rests, and the next answers", async () => {
  const store = fakeStore(["a", "b"])
  const clients = fakeClients({ a: refuse(429, '{"code":"110","message":"used up"}'), b: { ok: true, body: answer("hi") } })
  const p = pool({ store, clients })
  const got = await p.run({ conversation: { id: "c1" }, build: async (id) => ({ payload: { business: { name: id } }, model: { key: "m" } }) })
  assert.equal(got.account.id, "b")
  assert.ok(p.resting("a"), "the spent account rests")
  assert.match(p.snapshot().find((a) => a.id === "a").resting.why, /quota/)
  // the next request doesn't try it again
  const before = clients.calls.length
  const again = await p.run({ conversation: { id: "c2" }, build: async (id) => ({ payload: {}, model: { key: "m" } }) })
  assert.equal(again.account.id, "b")
  assert.equal(clients.calls.length, before + 1)
})

test("a refusal of the request itself doesn't fail over or rest anyone", async () => {
  const store = fakeStore(["a", "b"])
  const clients = fakeClients({ a: refuse(400, '{"code":"100400","message":"bad request"}'), b: { ok: true, body: answer("hi") } })
  const p = pool({ store, clients })
  await assert.rejects(
    p.run({ conversation: { id: "c" }, build: async () => ({ payload: {}, model: { key: "m" } }) }),
    (e) => e.status === 400 && e.kind === "request",
  )
  assert.equal(clients.calls.length, 1, "the second account was not asked")
  assert.equal(p.resting("a"), false)
})

test("a lapsed sign-in marks the account and the next one answers", async () => {
  const store = fakeStore(["a", "b"])
  const clients = fakeClients({ a: refuse(401, '{"code":"105","message":"expired"}'), b: { ok: true, body: answer("hi") } })
  const p = pool({ store, clients })
  const got = await p.run({ conversation: { id: "c" }, build: async () => ({ payload: {}, model: { key: "m" } }) })
  assert.equal(got.account.id, "b")
  assert.deepEqual(store.lapsedCalls, [["a", true]])
})

test("rests expire on their own", async () => {
  let now = 1000
  const store = fakeStore(["a", "b"])
  const p = pool({ store, clients: fakeClients({}), now: () => now })
  p.noteFailure("a", { kind: "quota", message: "x" })
  assert.ok(p.resting("a"))
  now += RESTS.quota + 1
  assert.equal(p.resting("a"), false)
})

test("a conversation stays with the account that answered it", async () => {
  const store = fakeStore(["a", "b"])
  const clients = fakeClients({ a: { ok: true, body: answer("a") }, b: { ok: true, body: answer("b") } })
  const p = pool({ store, clients })
  const build = async (id) => ({ payload: {}, model: { key: "m" } })
  const first = await p.run({ conversation: { id: "chat-1" }, build })
  assert.equal(first.account.id, "a")
  p.stick("chat-1", "a")
  // routing now prefers b, but the conversation stays on a
  p.noteUsage("b", { windows: [{ share: 0 }] })
  p.noteUsage("a", { windows: [{ share: 70 }] })
  const second = await p.run({ conversation: { id: "chat-1" }, build })
  assert.equal(second.account.id, "a")
  // a new conversation goes to b
  const other = await p.run({ conversation: { id: "chat-2" }, build })
  assert.equal(other.account.id, "b")
})

test("affinity off lets every request be routed anew", async () => {
  const store = fakeStore(["a", "b"], { routing: "smart", affinity: "off" })
  const p = pool({ store, clients: fakeClients({ a: { ok: true, body: answer("a") }, b: { ok: true, body: answer("b") } }) })
  p.stick("c", "a")
  p.noteUsage("b", { windows: [{ share: 0 }] })
  p.noteUsage("a", { windows: [{ share: 70 }] })
  const got = await p.run({ conversation: { id: "c" }, build: async () => ({ payload: {}, model: { key: "m" } }) })
  assert.equal(got.account.id, "b")
})

test("turn affinity holds a conversation only while tool results come back", () => {
  const store = fakeStore(["a", "b"], { routing: "smart", affinity: "turn" })
  const p = pool({ store, clients: fakeClients({}) })
  p.stick("c", "b")
  p.noteUsage("a", { windows: [{ share: 0 }] })
  p.noteUsage("b", { windows: [{ share: 70 }] })
  assert.equal(p.pick({ id: "c" }, { mid: false }).first.id, "a")
  assert.equal(p.pick({ id: "c" }, { mid: true }).first.id, "b")
})

test("no usable account is a 503, with what is wrong", async () => {
  const store = fakeStore([])
  const p = pool({ store, clients: fakeClients({}) })
  await assert.rejects(
    p.run({ conversation: { id: "c" }, build: async () => ({}) }),
    (e) => e.status === 503 && /sign in/.test(e.message),
  )
})

test("an account that can't serve the model is skipped", async () => {
  const store = fakeStore(["a", "b"])
  const clients = fakeClients({ b: { ok: true, body: answer("b") } })
  const p = pool({ store, clients })
  const got = await p.run({
    conversation: { id: "c" },
    build: async (id) => {
      if (id === "a") throw new Error("no such model")
      return { payload: {}, model: { key: "m" } }
    },
  })
  assert.equal(got.account.id, "b")
})

test("what an account served decays with an hour's half-life", () => {
  let now = 0
  const store = fakeStore(["a"])
  const p = pool({ store, clients: fakeClients({}), now: () => now })
  p.served("a", 100)
  assert.equal(Math.round(p.snapshot()[0].tokens), 100)
  now = 60 * 60 * 1000
  p.served("a", 0)
  assert.equal(Math.round(p.snapshot()[0].tokens), 50)
})

test("a conversation is named by the header, else its system line and first words", () => {
  const body = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }] }
  assert.equal(conversationOf({ "x-conversation-id": "h-1" }, body), "h-1")
  const id = conversationOf({}, body)
  assert.equal(id, conversationOf({}, body), "the same conversation hashes alike")
  assert.notEqual(id, conversationOf({}, { messages: [{ role: "system", content: "sys" }, { role: "user", content: "other" }] }))
  assert.ok(midTurn({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "" }, { role: "tool", content: "{}" }] }))
  assert.equal(midTurn({ messages: [{ role: "tool", content: "{}" }, { role: "user", content: "next" }] }), false)
})

test("usage is read from the account pages' own envelope", () => {
  const parsed = parseUsage({
    displayMode: "qoder",
    qoderUsage: {
      user_type: "pro",
      user_quota: { total: 2000, used: 500 },
      add_on_quota: { total: 100, remaining: 100 },
      org_resource_package: { total: 0, used: 0 },
      dedicated_resource_packages: [{ name: "Team", total: 50, used: 25, unit: "credits" }],
    },
  })
  assert.equal(parsed.plan, "pro")
  assert.deepEqual(parsed.windows.map((w) => [w.name, w.share]), [
    ["Credits", 25],
    ["Add-on credits", 0],
    ["Team", 50],
  ])
  assert.equal(parseUsage({ displayMode: "qoder", qoderUsage: {} }).windows.length, 0)
  // a plan with no credits states no window, and its own percentage stands in
  const bare = parseUsage({ displayMode: "qoder", qoderUsage: { userQuota: { total: 0, used: 0 }, totalUsagePercentage: 42 } })
  assert.equal(bare.windows.length, 0)
  assert.equal(bare.percent, 42)
  assert.equal(parseUsage({ displayMode: "enterprise" }).plan, "Enterprise")
})

test("a refusal Qoder puts inside a 200 is a failure, and the next account answers", async () => {
  const store = fakeStore(["a", "b"])
  const refused = Readable.from([
    Buffer.from('data:{"statusCodeValue":403,"statusCode":"FORBIDDEN","body":"{\\"code\\":\\"110\\",\\"message\\":\\"Billing daily count exceeded\\"}"}\n'),
  ])
  const clients = fakeClients({ a: { ok: true, body: refused }, b: { ok: true, body: answer("ok") } })
  const p = pool({ store, clients })
  const got = await p.run({ conversation: { id: "c" }, build: async () => ({ payload: {}, model: { key: "m" } }) })
  assert.equal(got.account.id, "b")
  assert.equal(p.resting("a"), true)
  assert.equal(p.snapshot().find((a) => a.id === "a").resting.why, "quota")
  // the body the caller gets still carries the whole answer
  const text = []
  for await (const c of got.upstream.body) text.push(Buffer.from(c).toString())
  assert.ok(text.join("").includes("ok"), "the answering stream still has its content")
})
