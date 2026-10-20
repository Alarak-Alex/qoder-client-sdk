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

### 确认登录状态

```sh
qoder-client whoami
```

输出：

```
account   you@example.com
uid       01a1xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
email     you@example.com
machineId 8f3c...（本机首次登录时生成）
expires   2026-10-21T05:31:27.000Z
```

### 凭据存在哪

默认写入 `~/.config/qoder-client/credentials.json`，权限 `0600`。

想换位置：

```sh
qoder-client login --credentials /path/to/creds.json
# 或
export QODER_CLIENT_CREDENTIALS=/path/to/creds.json
```

### 查看可用模型

```sh
qoder-client models
```

```
ultimate               Ultimate                   1000000  reasoning,image
fast                   Fast                       1000000  image
performance            Performance                1000000  image
dfmodel                DeepSeek-Flash             1000000  reasoning,image
...
17 models
```

模型列表来自你账号自己的清单，不是硬编码。不同套餐看到的模型不同。

---

## 对外提供接口

```sh
qoder-client serve --port 8787 --api-key sk-local
```

```
qoder-client serving on http://127.0.0.1:8787
  account you@example.com
  openai base_url http://127.0.0.1:8787/v1  (bearer key required)
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

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | 对话，支持 `stream` |
| GET | `/health` | 存活检查，不需要 key |

---

## 作为库使用

不启服务，直接在自己的 Node 程序里调用：

```js
import {
  QoderClient, IdentityCache, deviceSignIn, refreshJob,
  saveCredentials, requestBody, normalizeModels,
} from "qoder-client-sdk"

// 1. 登录（只做一次，之后从文件读）
const creds = await deviceSignIn(undefined, {
  onUrl: (url) => console.log("请打开：", url),
})
await saveCredentials(creds)

// 2. 建客户端
const client = new QoderClient({
  credentials: creds,
  identity: new IdentityCache(),   // 机器身份，自动缓存一小时
  refreshJob,                      // token 过期时自动刷新
  onCredentials: saveCredentials,
})

// 3. 列模型
const listing = await client.models()
const models = normalizeModels(listing, "chat")
const model = models.find((m) => m.key === "dfmodel")

// 4. 发请求，拿原始 SSE
const body = requestBody({ messages: [{ role: "user", content: "你好" }] }, model)
const res = await client.chat(body)

// 5. 用内置解析器转成 OpenAI 格式
import { readChat, streamChat } from "qoder-client-sdk"
const answer = await readChat(res.body, { id: "x", model: model.key })
console.log(answer.choices[0].message.content)
```

---

## 命令参考

```
qoder-client login [--pat]     登录（浏览器授权 / PAT）
qoder-client logout            删除本地凭据
qoder-client whoami            显示当前账号
qoder-client models            列出账号可用模型
qoder-client serve             启动 OpenAI 兼容服务
    --port <n>                 端口，默认 8787
    --host <addr>              监听地址，默认 127.0.0.1
    --api-key <key>            要求 Bearer key
    --model <key>              默认模型
```

所有命令都接受 `--credentials <path>`，或用环境变量
`QODER_CLIENT_CREDENTIALS`。

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

10 项离线测试，不需要网络也不需要账号：

- 编解码对照客户端产出的三组向量
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
