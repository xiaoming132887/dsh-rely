# dsh-rely · 中转站余额条

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的插件：在**聊天输入框正上方**常驻一条极简状态条 —— 只有**中转站名字 + 余额**，数字的颜色本身就是状态灯。点一下展开设置抽屉，里面只留三个输入框：**API Key / 刷新间隔 / 阈值**。

```
┌──────────────────────────────┐
│          绿萝  $35.49         │   ← 输入框上面这一行，点它开设置
├──────────────────────────────┤
│  输入框…                      │
└──────────────────────────────┘
```

- 不挤占输入框、不抢 token / 上下文条的位置，**独占一行**。
- 余额由**宿主进程**（Node 侧）定时拉取，浏览器只读缓存 → 站点不需要开 CORS，Key 也不进页面。
- 名字与站点地址在代码里**写死**，界面改不到；Key 保存一次即**锁死**，重启不变。

---

## 支持的余额接口

按顺序探测，第一个能解析出数字的胜出；全都拿不到就如实显示「查询失败」，**不伪造数字**。

| 中转站类型 | 请求 | 取的字段 |
| --- | --- | --- |
| **Sub2API** | `GET {base}/v1/usage?start_date=&end_date=&timezone=` | `remaining` / `quota.remaining`（币种取 `unit`） |
| new-api | `POST {base}/api/user/self` | `data.available_balance`（美元）或 `data.quota`（500000 ≈ $1） |
| one-api | `GET {base}/api/user/balance` | `balance` |
| OpenAI 兼容额度 | `GET {base}/v1/dashboard/billing/credit_grants` | `total_available` |

认证一律 `Authorization: Bearer <你的 sk-…>`。

> ⚠️ `hard_limit_usd`（OpenAI 的账户硬上限）**不是余额**，本插件不会拿它顶替，取不到就空着 —— 这是踩过的坑。

---

## 安装

### 从 GitHub 装

```bash
dsh plugin --profile <你的 profile 名> add github:xiaoming132887/dsh-rely
```

### 从本地目录装

```bash
git clone https://github.com/xiaoming132887/dsh-rely
dsh plugin --profile <你的 profile 名> add file:/绝对路径/dsh-rely
```

装完**要重启一次 DSH**：宿主半区（`src/index.js`，负责余额请求和 HTTP 路由）是 Node 模块，进程启动时只加载一次，停用/启用插件不会重新导入。

> 桌面端 profile 常叫 `desktop`，DSH 端一般是 `web`；用哪个就看你的 `$DSH_HOME/profiles/` 下面有哪个目录。

---

## 配置

点状态条 → 底部抽屉：

| 项 | 说明 |
| --- | --- |
| **API Key** | `sk-…`。留空保存 = 保留原 Key。已经保存过会显示打码值 + 🔒，要换得先点「更换 Key」。 |
| **服务端刷新（秒）** | 宿主多久去中转站拉一次余额，1–60 秒。**建议 30 秒以上**：每次都拉一整段用量数据，太勤容易被限流。 |
| **绿线阈值 (USD)** | 余额高于它 → 绿色 |
| **黄线阈值 (USD)** | 介于两者之间 → 黄色；再低 → 红色 |

**Key 的解析顺序**（不用配就能跑）：

1. 抽屉里保存过的 Key（存 `$DSH_HOME/rely/state.json`，权限 `0600`）—— 一旦有值就标记为**已锁定**；
2. 没有保存过时，回退读 DSH 凭据里的 `ZDXJL_API_KEY`（`$DSH_HOME/.credentials.yaml` 的 `refs`，或同名环境变量）。

**锁死规则**：已锁定后，不带 `unlockKey: true` 的覆盖请求会被服务端直接忽略 —— 空值不会把 Key 清掉，重启也从 `state.json` 原样读回。

---

## 写死区

站点名字和地址是代码常量，界面不提供编辑，`state.json` 里的历史值也覆盖不了：

```js
// src/index.js
const RELAY_NAME_LOCKED = '绿萝'
const RELAY_BASE_LOCKED = 'https://zdxjl.com'
const RELAY_KEY_ENV = 'ZDXJL_API_KEY'
```

换自己的站：改这三行（`RELAY_KEY_ENV` 填你在 DSH 凭据里存的 Key 名）→ 重启 DSH。

---

## 宿主 HTTP 接口

浏览器半区通过这两条路由读数据，本机 curl 也能调（需要 DSH 的登录会话）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET`/`POST` | `/rely/balances` | 读缓存；`?force=1` 或 POST = 立即现拉（有 1.5s 节流） |
| `GET` | `/rely/config` | 当前配置（Key 只回打码预览） |
| `POST` | `/rely/config` | 保存配置（阈值/刷新间隔/Key），持久化到 `state.json` |

---

## 目录结构

```
dsh-rely/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml      # 往 profile 加载器树里插一条 entry
├── src/index.js          # 宿主半区：定时拉余额 + /rely/* 路由 + 配置持久化
└── client/client.js      # 浏览器半区：状态条 + 设置抽屉（手写模块，无构建步骤）
```

浏览器半区是手写的 `window.__ModuleLoader__.load({ id, factory })` 模块，只 `require("react")`，**没有打包步骤**。

---

## 改代码后怎么生效

| 改的文件 | 生效方式 |
| --- | --- |
| `client/client.js` | 刷新页面（F5）即可 |
| `src/index.js`（宿主路由、余额请求、配置存储） | **必须重启 DSH** |

两条都踩过坑：

- **宿主路由别用同一个 `path` 注册两次。** DSH 的 `webServer.register` 遇到重复 `(kind, path)` 会 `throw`，而这个异常会把整个 inject 作用域里的 effect 全部回滚 —— 表现是「插件加载成功，但 `/rely/*` 全部 404，整条链路静默死掉」。所以 `GET`/`POST /rely/config` 必须写在**同一个 handler** 里。
- **别去改宿主容器的 flex 属性。** 状态条挂在 `conversation.input.dock`，它的容器是 `display:contents`，我们的行直接变成 `composerStack` 的 flex 子项。之前为了「独占一行」给父容器加过 `flex-wrap`，结果把同屏的「tok/s · 缓存命中」状态条挤没了。正确做法：**只用自己的类**，父容器一个字节都不碰。
- 位置就靠 DOM 顺序：`composerStack` 是 flex column，`conversation.input.dock` 排在输入框前面 → 天然在输入框上方。**`order` 不要设大**，设大了反而会掉到输入框下面。

---

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 状态条显示「查询失败」 | 点开抽屉看那一行红字。401/403 → Key 不对；404 → 站点接口路径不在上表里。 |
| 状态条显示「未配置」 | 没有可用 Key：抽屉里填一个，或在 DSH 凭据里存 `ZDXJL_API_KEY`。 |
| 显示的数字一直不动 | 「服务端刷新」被设得太长，或宿主半区没重载 → 重启 DSH。 |
| `/rely/*` 全部 404 | 宿主半区没挂上：确认插件是启用状态，然后**重启 DSH**。 |
| 数字明明在变，页面不动 | 浏览器半区按「前端轮询」拉缓存；刷新页面或等一个轮询周期。 |

---

## License

[MIT](./LICENSE)
