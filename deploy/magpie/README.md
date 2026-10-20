# magpie 在服务器上（Docker）

用 magpie 官方的纯终端镜像跑网关，Qoder 账号由一个插件服务。这台机器不持有
任何 refresh token，账号轮换、配额、token 续期都由 magpie 自己管。

比自带 SDK 池强的地方：不用维护第二份凭据、不用模拟机器身份、账号逻辑跟着
magpie 升级走。

## 一次性部署

```sh
cd <repo>
./deploy/magpie/deploy.sh --host 192.168.0.60
```

它做四件事：

1. 生成 `deploy/magpie/.env`（含一个固定的 `MAGPIE_WEB_KEY`）
2. 从本机 magpie 同步 Qoder 登录态到 `deploy/magpie/config`
3. 用镜像自己的 root 把 `/config` 改成 uid 65532（镜像以 nonroot 运行）
4. `docker compose up -d` 并打印状态

然后给调用方发密钥：

```sh
cd deploy/magpie
docker compose exec magpie magpie gateway-key add "laptop"
# sk-magpie-key-…
```

## 端口

| 端口 | 用途 |
|---|---|
| 3425 | 网关，OpenAI 兼容 `/v1` |
| 3430 | Web 页面（`?k=<MAGPIE_WEB_KEY>`） |

两个默认只发布在 `127.0.0.1`。**要给别人用**：

```sh
./deploy/magpie/deploy.sh --host 192.168.0.60 --lan
```

`--lan` 把 `127.0.0.1:` 前缀去掉；`--host` 写进 `MAGPIE_PUBLIC_URL`，否则
容器只知道自己的 `172.17.x`。

如果这台机器上已经跑着桌面版 magpie（3425 被占），脚本会自动改用 3426 并把
`MAGPIE_PUBLIC_URL` 跟着改。也可以手动在 `.env` 里设 `MAGPIE_PORT`。

## 调用

```bash
curl http://192.168.0.60:3425/v1/chat/completions \
  -H "Authorization: Bearer sk-magpie-key-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"qoder/dfmodel","messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.0.60:3425/v1", api_key="sk-magpie-key-…")
client.chat.completions.create(model="qoder/dfmodel", messages=[{"role": "user", "content": "你好"}])
```

模型 id 是 `provider/model`。`GET /v1/models` 列出可用的。

### 给每个调用方限额

```sh
docker compose exec magpie magpie gateway-key add "alice"
docker compose exec magpie magpie gateway-key limit <id> add day --tokens 2000000
docker compose exec magpie magpie gateway-key models <id> qoder/dfmodel qoder/qfmodel
```

## 同步账号

```sh
node tools/sync-magpie.mjs --to deploy/magpie/config --dry-run   # 先看
node tools/sync-magpie.mjs --to deploy/magpie/config
```

它读本机 `~/.config/magpie`，只搬 Qoder：

| 文件 | 内容 |
|---|---|
| `plugin-auth.json` | 每个账号的 job token、refresh token、设备 token、machineId |
| `logins.json` | 账号列表与顺序（plugin 的 token 不在这个文件里） |
| `plugin-providers.json` | 插件声明的模型 |
| `providers.json` | Qoder 的路由、模型选择、上下文 |
| `plugins.json` / `plugins.yml` | 启用的插件 |
| `settings.json` | 含 `pluginCheckins.qoder = false` |
| `plugins/node_modules` | 插件本体（约 268K），省掉容器联网装插件 |

`--all` 连其他 provider 一起搬。日志、配额历史、亲和记录这些运行时状态不搬。

**check-in 为什么要关**：Qoder 的签到要调用它自己的机器身份 helper
（`runtime-info`），那个只有桌面端和 CLI 才带。容器里每个账号每天报一次
`device identity runtime not found`，且签到也做不成。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 容器 `Exited (2)` | 宿主端口被占（本机桌面版 magpie 占着 3425） | 脚本会自动换端口；手动设 `.env` 的 `MAGPIE_PORT` |
| `magpie accounts` 列出账号但 `plugin didn't load: no such plugin` | `plugins/node_modules` 没同步 | 重跑同步脚本 |
| `no API key was sent` | 没带网关密钥，或用了别的 key | `magpie gateway-key add <name>`，用返回值 |
| 日志 `device identity runtime not found` | 签到开着 | 同步脚本会关掉 `pluginCheckins.qoder`；已部署的话在页面里关 |
| 同步后容器写入失败 | `/config` 属主不是 65532 | `docker run --rm -u 0 -v $PWD/config:/config --entrypoint sh ghcr.io/yetone/magpie:latest -c 'chown -R 65532:65532 /config'` |
| 其他机器 401 且密钥没错 | 端口只发布在 `127.0.0.1` | 重跑 `deploy.sh --lan --host <ip>` |

## 和自带 SDK 池的关系

`src/pool.js` 那套（自建多账号、自建路由）仍然在仓库里，但它需要自己持有
refresh token，会和 magpie 抢同一个一次性 token。两者**不要对同一批账号同时
运行**。日常用 magpie 这条路。
