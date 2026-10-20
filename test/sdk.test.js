// Offline checks: no network, no account needed.
//
// The codec vectors and the envelope shape come from the shipped client; the
// captured-body case runs only when a capture is present.

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { Readable } from "node:stream"
import { test } from "node:test"

import { decodeBody, encodeBody, cosyHeaders, COSY_VERSION } from "../src/cosy.js"
import { contextWindow, pickEffort, requestBody, normalizeModels } from "../src/client.js"
import { describeFailure, readChat, streamChat } from "../src/sse.js"

const CAPTURE = "/tmp/qoder-re/capture/requests.jsonl"
const cred = { uid: "01a1", access: "jt-test", email: "a@b.c", name: "T", machineId: "mid-1" }

test("codec matches the client's own vectors", () => {
  const vectors = [
    ["{\"a\":1}", "ep$$BMn%mYKi"],
    ["abcabc", "KMKM#S#S"],
    ["{\"model\":\"auto\",\"stream\":true}", "L#Sw*lECYJSFWOg.JHq*GoK^JZKmYKtu(CLuoByB"],
  ]
  for (const [plain, wire] of vectors) {
    assert.equal(encodeBody(plain), wire, `encode ${plain}`)
    assert.equal(decodeBody(wire), plain, `decode ${wire}`)
  }
})

test("envelope carries the client's headers", () => {
  const h = cosyHeaders("https://api3.qoder.sh/algo/api/v2/x?Encode=1", cred, "BODY", {
    ts: 1792475937,
    identity: { machineToken: "tok-real", machineType: "5d82dd10" },
  })
  const [scheme, payload, sig] = h.Authorization.split(".")
  assert.match(h.Authorization, /^Bearer COSY\./)
  assert.equal(scheme, "Bearer COSY")
  assert.match(sig, /^[0-9a-f]{32}$/)
  const decoded = JSON.parse(Buffer.from(payload, "base64").toString())
  assert.deepEqual(Object.keys(decoded), ["version", "requestId", "info", "cosyVersion", "ideVersion"])
  assert.equal(decoded.cosyVersion, COSY_VERSION)
  assert.equal(h["Cosy-MachineToken"], "tok-real")
  assert.equal(h["Cosy-MachineType"], "5d82dd10")
  assert.equal(h["Cosy-Version"], COSY_VERSION)
  assert.equal(h["Cosy-ClientType"], "10")
  assert.ok(!("Cosy-ClientIp" in h), "/algo calls omit Cosy-ClientIp")
})

test("non-algo calls keep Cosy-ClientIp and fall back without an identity", () => {
  const h = cosyHeaders("https://openapi.qoder.sh/sash/api/v1/me/campaigns", cred, "", { identity: null })
  assert.equal(h["Cosy-ClientIp"], "mid-1")
  assert.equal(h["Cosy-MachineToken"], "mid-1")
  assert.equal(h["Cosy-MachineType"], "5")
})

test("body carries the model's own settings", () => {
  const model = {
    key: "dfmodel",
    reasoning: true,
    context: 1000000,
    efforts: ["low", "high", "max"],
    config: { key: "dfmodel", source: "system" },
  }
  const body = requestBody(
    {
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "line one\nline two" },
        { role: "assistant", content: "ok", reasoning_content: "because" },
        { role: "tool", content: "{}", tool_call_id: "c1" },
      ],
    },
    model,
  )
  assert.equal(body.business.name, "line one")
  assert.equal(body.business.model_key, "dfmodel")
  assert.equal(body.parameters.reasoning_effort, "high")
  assert.equal(body.parameters.context_length, 1000000)
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user", "assistant", "tool"])
  assert.equal(body.messages[2].reasoning_content, "because")
  assert.equal(body.messages[3].tool_call_id, "c1")
})

test("effort snaps to the nearest level the model offers", () => {
  const levels = ["low", "high", "max"]
  assert.equal(pickEffort("minimal", levels), "low")
  assert.equal(pickEffort("medium", levels), "high")
  assert.equal(pickEffort("xhigh", levels), "max")
  assert.equal(pickEffort(undefined, levels), undefined)
})

test("context window is the largest the listing offers", () => {
  assert.equal(contextWindow({ context_config: { "200K": { token_count: 200000 }, "1M": { token_count: 1000000 } } }), 1000000)
  assert.equal(contextWindow({ max_input_tokens: 200000 }), 200000)
})

test("a queue position is not a lapsed sign-in", () => {
  assert.equal(describeFailure(403, '{"code":"10605","message":"queued"}').kind, "busy")
  assert.equal(describeFailure(401, '{"code":"105","message":"expired"}').kind, "auth")
  assert.equal(describeFailure(429, '{"code":"110","message":"used up"}').kind, "quota")
})

test("models are normalised from the account listing", () => {
  const list = normalizeModels(
    { chat: [
      { key: "auto", enable: true, display_name: "Auto" },
      { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true, max_input_tokens: 1000000 },
      { key: "off", enable: false, display_name: "Off" },
    ] },
    "chat",
  )
  assert.deepEqual(list.map((m) => m.key), ["ultimate"])
  assert.equal(list[0].name, "Ultimate")
  assert.equal(list[0].context, 1000000)
})

test("SSE becomes OpenAI chunks", async () => {
  const sse = [
    'data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"role\\":\\"assistant\\"},\\"index\\":0}]}"}',
    'data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"reasoning_content\\":\\"hm\\"},\\"index\\":0}]}"}',
    'data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"hello\\"},\\"index\\":0}]}"}',
    'data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{},\\"index\\":0,\\"finish_reason\\":\\"stop\\"}],\\"usage\\":{\\"prompt_tokens\\":5,\\"completion_tokens\\":2,\\"total_tokens\\":7}}"}',
    "",
  ].join("\n")
  const pieces = []
  for await (const p of streamChat(Readable.from([Buffer.from(sse)]), { id: "x", model: "m" })) pieces.push(p)
  assert.equal(pieces.at(-1).choices[0].finish_reason, "stop")
  assert.equal(pieces.at(-1).usage.total_tokens, 7)
  const text = pieces.map((p) => p.choices[0].delta.content ?? "").join("")
  assert.equal(text, "hello")

  const whole = await readChat(Readable.from([Buffer.from(sse)]), { id: "x", model: "m" })
  assert.equal(whole.object, "chat.completion")
  assert.equal(whole.choices[0].message.content, "hello")
  assert.equal(whole.choices[0].message.reasoning_content, "hm")
  assert.equal(whole.usage.total_tokens, 7)
})

test("a captured client body decodes and re-encodes", { skip: !existsSync(`${CAPTURE}.body`) }, () => {
  const wire = readFileSync(`${CAPTURE}.body`, "latin1")
  const plain = decodeBody(wire)
  assert.equal(encodeBody(plain), wire)
  assert.ok(JSON.parse(plain).business)
})
