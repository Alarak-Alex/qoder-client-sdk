# qoder-client-sdk

把 Qoder 当作它自己的客户端来调用，并对外提供 OpenAI 兼容接口。

它不走任何“开放 API 端点”，而是直接请求桌面客户端用的同一个
`agent_chat_generation` 流，用同一套 COSY 信封签名，带同一组机器身份头。
对外暴露 `POST /v1/chat/completions`，任何 OpenAI SDK 都能直接接。

协议细节从 Qoder 0.4.8（worker runtime 1.1.69）中还原，并用客户端自己发出的
真实流量逐项核对过。

---

## 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [登录](#登录)
- [多账号](#多账号)
- [部署到服务器](#部署到服务器)
- [用 magpie 部署（推荐）](#用-magpie-部署推荐)
- [Web UI](#web-ui)
- [对外提供接口](#对外提供接口)
- [作为库使用](#作为库使用)
- [命令参考](#命令参考)
- [它为什么像官方客户端](#它为什么像官方客户端)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [开发与测试](#开发与测试)

---

## 它做什么

```
你的程序 / OpenAI SDK
        │  HTTP，标准 OpenAI 格式
        ▼
  qoder-client serve            ← 本机 127.0.0.1:8787
        │  客户端协议：COSY 信封 + 自定义 body 编码 + 机器身份头
        ▼
  api3.qoder.sh /algo/api/v2/service/pro/sse/agent_chat_generation
        │  SSE
        ▼
  转成 OpenAI chat.completion.chunk 流式返回
```

职责划分：

| 谁 | 负责 |
|---|---|
| Qoder 桌面端 / 官方 helper | 提供机器身份（`machineToken` / `machineType`） |
| 本 SDK | 登录态、COSY 签名、请求编码、SSE 转换 |
| 你的程序 | 只看到标准 OpenAI 接口 |

---

## 安装

需要 Node.js 18 或更高版本。没有任何第三方依赖。

```sh
git clone git@github.com:Alarak-Alex/qoder-client-sdk.git
cd qoder-client-sdk
npm link
```

`npm link` 会把 `qoder-client` 命令装到全局。也可以不装，直接用
`node bin/qoder-client.js` 代替下面所有命令里的 `qoder-client`。

---

## 登录

### 方式一：浏览器授权（推荐）

```sh
qoder-client login
```

终端会打印一个 `qoder.com` 的授权链接并自动打开浏览器。在页面上确认授权后，
终端会轮询到结果并自动保存凭据。

### 方式二：Personal Access Token

```sh
qoder-client login --pat
```

按提示粘贴 PAT。适合没有浏览器的机器（服务器、容器）。

### 方式三：从 magpie 导入

本机装了 [magpie](https://github.com/yetone/magpie) 并且已经登录了 Qoder 时，
不必再登录一遍：

```sh
qoder-client import
```

它会读 `~/.config/magpie/plugin-auth.json` 里所有 `qoder` / `qoder#…` 条目的
job token、refresh token、设备 token 与 machineId，按 uid 去重后并进账号库。

### 凭据存在哪

账号库默认是 `~/.config/qoder-client/accounts.json`，权限 `0600`。一个文件里
放多个账号和路由策略，不再有单账号的 `credentials.json`（旧的会在首次运行时
被并进来）。

想换位置：

```sh
qoder-client login --accounts /path/to/accounts.json
# 或
export QODER_CLIENT_ACCOUNTS=/path/to/accounts.json
```

### 查看账号和余额

```sh
qoder-client accounts
```

```
01a15722-799f-7837-99de-e6ebd0bd4545  0/100 credits
01a157c4-29bc-7cbd-a673-305638b9da0f  usage: -
...
routing smart, affinity session  (/Users/you/.config/qoder-client/accounts.json)
```

模型列表来自各账号自己的清单，不是硬编码；不同套餐看到的模型不同，
`GET /v1/models` 返回的是所有开启账号的并集。

---

## 多账号

一个进程服务账号库里的全部账号，对外仍然只有一个端点、一个 key。

### 路由

`routing` 决定一个请求先给谁：

| 值 | 顺序 |
|---|---|
| `smart`（默认） | 有额度的按已用比例升序；90% 以上的垫后；用尽的最后；额度未知的排在已知之后 |
| `usage` | 已用最少的优先 |
| `rotate` | 每个请求轮换到下一个 |
| `order` | 按账号库里的顺序 |

### 会话粘性

`affinity` 决定一段对话要不要留在应答它的账号上：

| 值 | 行为 |
|---|---|
| `session`（默认） | 整个对话留在同一账号，保住服务端的 prompt 缓存 |
| `turn` | 只在一轮之内留守（工具结果回传时），用户再次发言就重新选 |
| `off` | 每个请求都重新选 |

对话的标识优先取请求头 `x-conversation-id`（或 `x-session-id`）；没有时用
system 行加上用户第一条消息的哈希，同一段对话每轮都会算成同一个。

### 失败转移

- 账号拒绝（额度用尽、排队、网络错误）→ 这个账号休息一会儿，请求换下一个，
  调用方看不到这些。
- **Qoder 会把拒绝塞进 HTTP 200 的 SSE 帧里**（`statusCodeValue: 403`、
  `code: 110`）。SDK 会先窥探第一帧再决定换不换号，所以额度用尽的账号不会
  把错误透给调用方。
- 请求本身被拒（`code` 400/416/430/80411/…）不换号，原样返回给调用方。

休息时长：额度 15 分钟、排队 30 秒、网络 15 秒、其他 1 分钟。UI 上可以手动
解除。

### 配置

```sh
# 命令行
qoder-client serve --routing smart --affinity session

# 或在 Web UI 里选
```

---

## 部署到服务器

服务器上没有 Qoder 的机器身份 helper（`runtime-info` 只有桌面端和 CLI 才
带）。两种办法：

1. 把 Qoder CLI 装上去并登录一次，helper 会落到 `~/.qoder/.bin`；
2. 在一台装了 Qoder 的机器上读出身份，用环境变量带过去（推荐）。

读身份：

```sh
node -e 'import("./src/identity.js").then(async m => {
  const i = await m.readIdentity()
  console.log(i.machineToken, i.machineType)
})'
```

然后用 Docker Compose：

```sh
cp .env.example .env
# 填 QODER_CLIENT_API_KEY、QODER_CLIENT_ADMIN_KEY、QODER_MACHINE_TOKEN、
# QODER_MACHINE_TYPE、QODER_MACHINE_OS
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

`QODER_MACHINE_OS` 填读身份那台机器的（如 `aarch64_darwin`）：机器 token 是
那台机器的，信封里的 `Cosy-MachineOS` 也要跟着它，否则两者对不上。不填就按
容器自己的平台报（`x86_64_linux`），和使用那台机器 identity 的真实客户端不一致。

账号库挂到 `./data/accounts.json`。容器里的进程用 `POOL_UID`/`POOL_GID`
（默认 1000:1000）跑，要跟文件属主一致，否则写不进去。

只需要一个端口（默认 8787）。账号不按端口分，全部走同一个端点。

---

## 用 magpie 部署（推荐）

多账号部署时用 magpie 的官方镜像，别用本项目的池：

```sh
./deploy/magpie/deploy.sh --host 192.168.0.60 --lan
```

它起 `ghcr.io/yetone/magpie:latest`（纯终端版，网关 + Web 页面），并把本机
magpie 里已登录的 Qoder 账号同步进去。调用方用 magpie 的网关密钥：

```bash
curl http://192.168.0.60:3425/v1/chat/completions \
  -H "Authorization: Bearer sk-magpie-key-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"qoder/dfmodel","messages":[{"role":"user","content":"你好"}]}'
```

**为什么**：Qoder 的 refresh token 一次性，同一个账号被两个程序各刷一次就会
互相踢掉。magpie 是唯一持有凭据的一方，就不会有这个问题；token 续期、配额、
账号排序也都不必自己写。

细节、限额、排查：[deploy/magpie/README.md](deploy/magpie/README.md)。
同步脚本可以单独用：`node tools/sync-magpie.mjs --to <dir> --dry-run`。

---

## Web UI

浏览器打开 `http://<host>:8787/`，输入管理密钥（`--admin-key`，没设就是
`--api-key`）。页面上可以：

- 看每个账号的额度、休息状态、最近服务的 token 数
- 浏览器登录 / 粘贴 PAT 加账号，删除、停用、手动读额度、解除休息
- 切换 `routing` 和 `affinity`
- 看最近的路由决策（谁被跳过、为什么）

管理接口在 `/admin/api/` 下，`/admin/api/state` 返回整页的数据。

---

## 对外提供接口

```sh
qoder-client serve --port 8787 --api-key sk-local
```

```
qoder-client serving on http://127.0.0.1:8787
  accounts  7 (7 on), routing smart, affinity session
  openai    http://127.0.0.1:8787/v1  (bearer key required)
  web ui    http://127.0.0.1:8787/
```

`--api-key` 建议一定要设。不设的话，本机任何程序都能白用你的额度。

### 用 OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-local")

# 非流式
r = client.chat.completions.create(
    model="dfmodel",
    messages=[{"role": "user", "content": "用一句话解释什么是闭包"}],
)
print(r.choices[0].message.content)
print(r.usage)
```

### 流式

```python
stream = client.chat.completions.create(
    model="dfmodel",
    messages=[{"role": "user", "content": "写一个快速排序"}],
    stream=True,
)
for chunk in stream:
    d = chunk.choices[0].delta
    if getattr(d, "reasoning_content", None):
        print(d.reasoning_content, end="", flush=True)   # 思维链
    if d.content:
        print(d.content, end="", flush=True)
```

### 用 curl

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dfmodel",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

### 工具调用

按标准 OpenAI 格式传 `tools`，Qoder 返回的 `tool_calls` 会原样转换：

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查天气",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
    },
}]
r = client.chat.completions.create(model="dfmodel", messages=[...], tools=tools)
if r.choices[0].message.tool_calls:
    for tc in r.choices[0].message.tool_calls:
        print(tc.function.name, tc.function.arguments)
```

### 推理强度

`reasoning_effort` 会自动映射到该模型支持的档位
（`minimal` / `low` / `medium` / `high` / `xhigh` / `max`）：

```python
client.chat.completions.create(model="dfmodel", messages=[...], reasoning_effort="high")
```

模型不支持该档位时，取最接近的一档；间距相同时取更高的一档。

### 会话粘性头

同一段对话要留在同一个账号上（保住 prompt 缓存），带上对话 id：

```sh
curl ... -H "x-conversation-id: my-chat-42"
```

不带也能工作：SDK 用 system 行 + 用户第一条消息的哈希当 id。但如果两次请求的
system 都为空、第一条消息又是同一句，它们会被当成同一段对话。

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 所有开启账号的模型并集 |
| POST | `/v1/chat/completions` | 对话，支持 `stream`；池子自己选账号 |
| GET | `/health` | 存活检查，不需要 key |
| GET | `/` | Web UI |
| GET | `/admin/api/state` | 账号、路由策略、最近决策 |
| POST | `/admin/api/policy` | 改 `routing` / `affinity` |
| POST | `/admin/api/refresh` | 读全部账号的额度 |
| POST | `/admin/api/login` | 开始浏览器登录，返回轮询 id |
| POST | `/admin/api/login/pat` | 用 PAT 加账号 |
| POST | `/admin/api/accounts/<id>/enabled` | 停用/启用 |
| POST | `/admin/api/accounts/<id>/unrest` | 解除休息 |
| POST | `/admin/api/accounts/<id>/usage` | 读这个账号的额度 |
| DELETE | `/admin/api/accounts/<id>` | 删账号 |

---

## 作为库使用

不启服务，直接在自己的 Node 程序里调用：

```js
import {
  AccountStore, Pool, IdentityCache, QoderClient,
  deviceSignIn, patSignIn, importMagpie, readUsage,
  requestBody, normalizeModels,
} from "qoder-client-sdk"

// 1. 账号库：登录、导入，或读取已有的文件
const store = await new AccountStore().load()
await store.add(await deviceSignIn(undefined, { onUrl: (u) => console.log(u) }))
// 已经有 magpie 的话：await importMagpie(store)

// 2. 池子：账号、路由策略、额度、休息
const clients = new Map()
const pool = new Pool({
  store,
  clientFor: (id) => {
    if (!clients.has(id)) {
      clients.set(id, new QoderClient({ credentials: store.creds(id), identity: new IdentityCache(), refreshJob: store.refresher(id) }))
    }
    return clients.get(id)
  },
  usageOf: (id) => readUsage(store, id),
})
await pool.refreshAll()          // 后台读一遍额度，路由才有依据

// 3. 发请求：池子自己选号、失败换号
const { account, upstream, model } = await pool.run({
  conversation: { id: "my-chat", body: chat },
  build: async (id) => {
    const list = normalizeModels(await clients.get(id).models(), "chat")
    const m = list.find((x) => x.key === "dfmodel")
    return { payload: requestBody(chat, m), model: m }
  },
})

// 4. 转成 OpenAI 格式
import { readChat } from "qoder-client-sdk"
const answer = await readChat(upstream.body, { id: "x", model: model.key })
pool.served(account.id, answer.usage?.total_tokens)
pool.stick("my-chat", account.id)
```

不想管账号池、只要一个账号时，`QoderClient` 本身照旧可用（`credentials` 直接
传一份登录结果）。

---

## 命令参考

```
qoder-client login [--pat]     加一个账号（浏览器授权 / PAT）
qoder-client import            从 magpie 导入已登录的 Qoder 账号
qoder-client accounts          列出账号和各自余额
qoder-client logout [<id>]     删一个账号，或全部
qoder-client serve             启动 OpenAI 兼容服务
    --port <n>                 端口，默认 8787
    --host <addr>              监听地址，默认 127.0.0.1
    --api-key <key>            调用方用的 Bearer key
    --admin-key <key>          Web UI / admin API 的 key（默认同 --api-key）
    --model <key>              默认模型
```

所有命令都接受 `--accounts <path>`，或用环境变量 `QODER_CLIENT_ACCOUNTS`
（默认 `~/.config/qoder-client/accounts.json`）。

---

## 它为什么像官方客户端

真正决定“看起来像不像”的，是下面这几处能被服务端直接看到的细节：

| 字段 | Qoder 客户端 | 本 SDK |
|---|---|---|
| `Authorization` | `Bearer COSY.<base64>.<md5>` | 相同 |
| 用户块 | AES-128-CBC，密钥用内置 RSA 公钥包裹 | 相同 |
| `Cosy-Version` | `1.1.69` | 相同 |
| `Cosy-ClientType` | `10`（桌面端） | 相同 |
| `Cosy-MachineToken` | 原生 helper 输出的真值 | 相同，直接调用官方 helper |
| `Cosy-MachineType` | 同上 | 相同 |
| `Cosy-ClientIp` | 只在非 `/algo` 路径发送 | 相同 |
| `business.name` | 本轮用户输入的首行 | 相同 |
| body 编码 | 打乱字母表的 base64，首尾三分之一对调 | 相同，逐字节可逆 |

### 机器身份这一项最关键

官方 helper 是 `~/.qoder/.bin/runtime-info-darwin-arm64-<hash>`（Windows 上是
`umid-win32-*` 目录）。它的**第一个参数是 environment，不同取值返回不同的机器
token**：

| 参数 | 含义 | 与桌面端是否一致 |
|---|---|---|
| `4` | 桌面端 | 是，`umid-cache.json` 和实际流量都是这一组 |
| `3` | CLI | 否 |
| `0` | 另一环境 | 否 |

实测：同一台机器上，`env=4` 与 `env=3` 返回的机器 token 完全不同；`env=4`
那一组与 `~/.qoder/umid-cache.json` 以及抓到的桌面端请求**逐字符相同**。差值
仅在于 environment 参数，与账号无关（传入不同 uid 得到的 token 相同）。

所以本 SDK 固定用 environment 4。声明自己是桌面端（`Cosy-ClientType: 10`）
却发送 CLI 的机器 token，是一个任何真实客户端都不会产生的组合。

### 如果本机没装 Qoder

找不到 helper 时，信封会退回用 `machineId` 充当 token，`machineType` 填 `5`。
功能仍然可用，但**这个形状没有真实客户端会发**，属于明显的第三方调用特征。

---

## 常见问题

### 提示 “not signed in”

先跑 `qoder-client login`。如果在别的机器登录过，用
`--credentials` 指向那份凭据文件。

### 提示 “Qoder's identity helper wasn't found”

三条路任选：

1. 装 Qoder 桌面端并登录一次
2. 装 Qoder CLI 并登录一次（helper 会缓存到 `~/.qoder/.bin`）
3. 手动指定：`export QODER_RUNTIME_INFO=/path/to/runtime-info`

### 返回 401 或 403

先看错误码：

- `105` = 登录过期，重新 `qoder-client login`
- `10605` = 排队中，稍后重试（不是登录问题）
- 其他 401/403 可能是额度或请求被拒

### 返回 429

额度用尽或触发限流。错误码 `110`、`112`–`119`、`122` 都属于额度类。

### 流式输出里没有 `content`

说明模型还在输出思维链。本 SDK 把思维链放在 `delta.reasoning_content`，
`content` 为空是正常的。等服务端开始输出正文即可。

### 想换端口或被其他机器访问

```sh
qoder-client serve --host 0.0.0.0 --port 9000 --api-key 一个足够长的随机串
```

注意：`--host 0.0.0.0` 会让局域网内其他机器也能访问，务必设 `--api-key`。

---

## 已知限制

- **需要已登录的 Qoder 账号**，调用消耗的是该账号的 credits。
- **额度不公开的套餐无法按额度排序**。有些账号的用量接口只回
  `userQuota.total = 0`，既没有窗口也没有可用比例；这种账号的 `share` 记为
  未知，排在已知额度之后，靠实际失败来休息。`isQuotaExceeded` 没有采用：
  实测它为 `true` 的账号能正常回答，为 `false` 的反而报 110。
- **休息状态不落盘**，进程重启后清空；账号和路由策略落盘。
- **`COSY_VERSION` 是写死的 `1.1.69`**。客户端升级后需要同步改这个值，否则
  仅凭版本号就能看出流量是旧的。
- **不做自动重试**，配额统计也不做。
- **不解析文本里的工具调用**。Qoder 有时把 tool call 写成 XML 混在
  `delta.content` 里，本 SDK 会当作普通文本返回。走 `tools` 参数的调用不受影响。
- **device flow 尚未做过真实端到端登录**。端点和参数按客户端实现写好，但没有
  实际跑过一次完整授权。首次使用 `login` 时请留意输出。
- 服务默认只监听 `127.0.0.1`。

---

## 开发与测试

```sh
npm test
```

26 项离线测试，不需要网络也不需要账号：

- 编解码对照客户端产出的三组向量
- 路由策略、休息与恢复、会话粘性、失败转移（含 SSE 内嵌的拒绝）
- 用量信封解析
- COSY 信封结构、`Cosy-Version`、`/algo` 不带 `Cosy-ClientIp`
- 请求体 `business` / `parameters` / tool 消息 / reasoning 保留
- 真实 SSE 响应的解析与 usage 映射
- 错误码分类（`105` 登录过期、`10605` 排队、`110` 额度）

### 目录结构

```
src/cosy.js      COSY 信封、AES+RSA 用户块、body 编解码
src/identity.js  定位并调用原生 helper，environment 可选，一小时缓存
src/auth.js      device flow、PAT、token 刷新、0600 凭据存储
src/client.js    模型列表、agent_chat_generation 请求、401 自动刷新重试
src/sse.js       SSE 解析、错误码归类、OpenAI chunk 转换
src/server.js    /v1/models、/v1/chat/completions、/health
bin/qoder-client.js  命令行入口
```

### 自建 fixture

想用真实请求体验证编解码，把抓到的编码后 body 存成文件，再指定给它：

```sh
QODER_CAPTURE_BODY=/path/to/body.txt npm test
```

该用例会检查解码后能解析出 `business`，并且重新编码与原始字节完全一致。
不设这个变量时该用例自动跳过，其余 9 项照常运行。
