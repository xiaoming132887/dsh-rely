/**
 * dsh-rely — 中转站余额常驻条 (v0.1.0)
 *
 * 服务端半边：
 *   - 定时拉取 one-api / new-api 系中转站余额端点，缓存到内存
 *   - HTTP 路由 /rely/* 只读缓存 + 配置读写给客户端半边
 *
 * 客户端半边 (client/client.js)：
 *   - 状态条常驻在输入框下方 (conversation.composer.dock 槽位)
 *   - 显示：站点名 + 余额 + 三色阈值灯；点击/长按展开设置
 *
 * 设计要点（照 dsh-api-dashboard 已踩实的坑走）：
 *   - peer 依赖用宿主目录 CJS 回退解析（proot 软链环境）
 *   - 插件路由自带鉴权闸门 (connection.requestRejection)
 *   - 配置持久化到状态文件，key 不落日志
 *   - 余额端点（按序探测，第一个能解析出数字的胜出）：
 *       Sub2API 系: GET  {base}/v1/usage?start_date=&end_date=&timezone=
 *                   → 顶层 remaining / quota.remaining（zdxjl.com 实测可用，余额 $41.97）
 *       new-api 系: POST {base}/api/user/self
 *       兼容:       GET  {base}/api/user/balance (老 one-api)
 *                   GET  {base}/v1/dashboard/billing/credit_grants (OpenAI 兼容)
 *     解析字段：
 *       Sub2API:   remaining / quota.remaining（unit 给币种，实测 USD）
 *       new-api:   data.available_balance (美元) / data.quota (500000 = $1)
 *       one-api:   data.quota (500000 = $1, 系数同官方看板, 未实测)
 *     两者都取不到时如实返回 status='no-balance-api'，不伪造数字。
 *
 *   - 写死区：relayName='绿萝' / relayBase='https://zdxjl.com' 由代码常量锁定，
 *     界面改不了、state.json 里的历史值也覆盖不了。
 *   - key 锁死：保存一次即落盘 + 标记 keyLocked，重启从 state.json 原样读回；
 *     没保存过则回退到 DSH 凭据里的 ZDXJL_API_KEY（同样是固定来源）。
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * peer 依赖加载器（同 dsh-api-dashboard v1.4.1 的思路）。
 * DSHA 跑在 proot 里带 --link2symlink，pnpm 硬链被降级成指向 store 的软链；
 * Node ESM 先 realpath 再向上找 node_modules，从 store 目录永远走不到
 * $DSH_HOME/profiles/node_modules —— 所以失败时改用宿主目录做 CJS 解析。
 */
const resolvePeer = async (spec) => {
  let primary = null
  try { return await import(spec) } catch (e) { primary = e }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const bases = [
    join(home, 'profiles', 'node_modules', '__rely_resolver__.cjs'),
    join(home, 'profiles', process.env.DSHA_STARTUP_PROFILE || 'web', 'node_modules', '__rely_resolver__.cjs'),
  ]
  for (const base of bases) {
    try {
      const entry = createRequire(base).resolve(spec)
      const { pathToFileURL } = await import('node:url')
      return await import(pathToFileURL(entry).href)
    } catch { /* 试下一个 */ }
  }
  throw primary
}

export const name = 'dsh-rely'

// ============================================================
// 插件根目录 / 持久化
// ============================================================
const SELF_ROOT = (() => {
  const fromUrl = dirname(dirname(fileURLToPath(import.meta.url)))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSHA_STARTUP_PROFILE || 'web'
  const candidates = [
    fromUrl,
    join(home, 'profiles', profile, 'node_modules', 'dsh-rely'),
    join(home, 'profiles', 'node_modules', 'dsh-rely'),
  ]
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg && pkg.name === 'dsh-rely') return dir
    } catch { /* 下一个 */ }
  }
  return fromUrl
})()

const DSH_HOME_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME_DIR, 'rely')
const STATE_FILE = join(STATE_DIR, 'state.json')

// ============================================================
// 写死区（主人指定；界面改不了，state.json 里的历史值也覆盖不了）
// ============================================================
const RELAY_NAME_LOCKED = '绿萝'
const RELAY_BASE_LOCKED = 'https://zdxjl.com'
// DSH 凭据里中转站的 key（settings 的 zdxjl provider 用的就是这一把）
const RELAY_KEY_ENV = 'ZDXJL_API_KEY'

const DEFAULT_CONFIG = {
  // 中转站名（写死：绿萝）
  relayName: RELAY_NAME_LOCKED,
  // 站点地址（写死：zdxjl.com）
  relayBase: RELAY_BASE_LOCKED,
  // API key：优先主人保存的那把，其次读 DSH 凭据；有值即视为锁定
  apiKey: '',
  // key 是否已锁定（true = 抽屉里只读、服务端拒绝被覆盖）
  keyLocked: false,
  // key 来源标记：'saved' | 'credentials' | ''
  keySource: '',
  // 刷新间隔 ms（1~60s）
  refreshIntervalMs: 30000,
  // 客户端轮询 /rely/balances 的间隔 ms
  clientPollIntervalMs: 30000,
  // 单次余额请求超时
  timeoutMs: 8000,
  // 阈值（美元）：高于 safe 绿 / 高于 warn 黄 / 否则红
  safeThreshold: 1,
  warnThreshold: 0.1,
  // 是否启用（关闭时状态条不渲染，服务端照常缓存? 不 —— 关闭时跳过刷新循环）
  enabled: true,
}

/**
 * 从 DSH 凭据（.credentials.yaml 的 refs）或环境变量读中转站 key。
 * 这是「写死来源」：主人不填也能直接显示余额，界面改不到它。
 */
function readCredentialKey() {
  const fromEnv = (process.env[RELAY_KEY_ENV] || '').trim()
  if (fromEnv) return fromEnv
  try {
    const raw = readFileSync(join(DSH_HOME_DIR, '.credentials.yaml'), 'utf8')
    // 注意：字符串里的 \s 必须写成 \\s，否则 JS 会把它吃掉变成字面量 's'
    const re = new RegExp('^\\s*' + RELAY_KEY_ENV + ':\\s*["\']?([^"\'\\s]+)["\']?\\s*$', 'm')
    const m = raw.match(re)
    if (m) return m[1].trim()
  } catch { /* 没有凭据文件就走空 */ }
  return ''
}

let runtimeConfig = loadPersisted()
function loadPersisted() {
  let raw = null
  try { raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { raw = null }
  const merged = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  // 写死字段：不管 state.json 里历史存了什么，一律拉回代码常量
  merged.relayName = RELAY_NAME_LOCKED
  merged.relayBase = RELAY_BASE_LOCKED
  // 抽屉里的「启用」开关已经删掉了，所以这里强制常开 —— 免得历史配置
  // 里留着 enabled:false，把刷新循环悄悄停掉，状态条永远显示「查询中」
  merged.enabled = true
  // key：保存过的优先；没有就吃 DSH 凭据里的那把（同样是锁死来源）
  if (!merged.apiKey) {
    const ck = readCredentialKey()
    if (ck) { merged.apiKey = ck; merged.keySource = 'credentials' }
  }
  if (merged.apiKey) {
    merged.keyLocked = true
    if (!merged.keySource) merged.keySource = 'saved'
  }
  return merged
}
function savePersisted(patch) {
  try {
    runtimeConfig = { ...runtimeConfig, ...patch }
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    // 原子写：tmp + rename
    const tmp = join(STATE_DIR, `state.tmp-${process.pid}`)
    writeFileSync(tmp, JSON.stringify(runtimeConfig, null, 2))
    renameSync(tmp, STATE_FILE)
    // key 落盘但不进日志 —— 权限收严
    try { chmodStateFile() } catch { /* 忽略 */ }
  } catch { /* 写失败不影响本次运行 */ }
}
function chmodStateFile() {
  try { chmodSync(STATE_FILE, 0o600) } catch { /* 忽略 */ }
}

// ============================================================
// 余额查询（one-api / new-api）
// ============================================================
async function fetchWithTimeout(url, headers, timeoutMs, method = 'GET', body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method, headers, signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析余额端点响应。顺序覆盖 new-api → one-api → 老版 /user/balance。
 * 全部拿不到返回 null（客户端据此显示「未开放」，不伪造数字）。
 */
function parseBalance(json, baseUrl) {
  if (!json || typeof json !== 'object') return null
  // ⓪ Sub2API 系（zdxjl.com 就是它）：GET /v1/usage 用 sk- key 就能读
  //    余额在顶层 remaining（或 quota.remaining），unit 给币种
  const sub2Remaining = (typeof json.remaining === 'number' && isFinite(json.remaining))
    ? json.remaining
    : (json.quota && typeof json.quota.remaining === 'number' && isFinite(json.quota.remaining) ? json.quota.remaining : null)
  if (sub2Remaining != null) {
    return {
      total: sub2Remaining,
      currency: json.unit || (json.quota && json.quota.unit) || 'USD',
      note: 'Sub2API /v1/usage remaining',
      variant: 'sub2api',
      quotaLimit: json.quota && typeof json.quota.limit === 'number' ? json.quota.limit : null,
      quotaUsed: json.quota && typeof json.quota.used === 'number' ? json.quota.used : null,
    }
  }
  const d = json.data
  // ① new-api: available_balance 直接就是美元
  if (d && typeof d.available_balance === 'number' && isFinite(d.available_balance)) {
    return { total: d.available_balance, currency: 'USD', note: 'new-api available_balance', variant: 'new-api' }
  }
  // ② quota 折算（one-api / new-api 通用，500000 quota ≈ $1 —— 系数同官方看板，实测前请知悉）
  const quota = (d && typeof d.quota === 'number') ? d.quota : (typeof json.quota === 'number' ? json.quota : null)
  if (quota != null && isFinite(quota)) {
    return { total: quota / 500000, currency: 'USD', note: 'quota ÷500000 (近似美元)', variant: 'quota' }
  }
  // ③ 老 one-api /user/balance
  if (typeof json.balance === 'number' && isFinite(json.balance)) {
    return { total: json.balance, currency: 'CNY', note: 'one-api user/balance', variant: 'one-api' }
  }
  // ④ 有些 new-api 部署把 available_balance 放在顶层
  if (typeof json.available_balance === 'number' && isFinite(json.available_balance)) {
    return { total: json.available_balance, currency: 'USD', note: 'new-api available_balance(顶层)', variant: 'new-api' }
  }
  // ⑤ OpenAI 兼容额度：/v1/dashboard/billing/credit_grants 的 total_available
  //    （硬上限 hard_limit_usd 不是余额，绝不拿来顶替 —— 见官方看板踩过的坑）
  if (typeof json.total_available === 'number' && isFinite(json.total_available)) {
    return { total: json.total_available, currency: 'USD', note: 'credit_grants total_available', variant: 'openai' }
  }
  return null
}

/** Sub2API /v1/usage 必带的日期区间（站点按这个区间统计；余额字段与区间无关） */
function sub2apiRangeQuery() {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10)
  const now = Date.now()
  return `start_date=${fmt(now - 29 * 86400000)}&end_date=${fmt(now)}&timezone=Asia/Shanghai`
}

const ENDPOINTS = [
  // Sub2API（zdxjl.com 实测）：GET /v1/usage —— sk- key 直接能读余额 remaining
  { variant: 'sub2api', path: '/v1/usage', method: 'GET', query: sub2apiRangeQuery },
  // new-api 系：POST /api/user/self
  { variant: 'new-api', path: '/api/user/self', method: 'POST' },
  // one-api 系
  { variant: 'one-api', path: '/api/user/balance', method: 'GET' },
  // OpenAI 兼容额度（sk- key 走这条也常见）
  { variant: 'openai', path: '/v1/dashboard/billing/credit_grants', method: 'GET' },
  // 兜底：老 one-api 的 /api/user/self（部分部署把 self 做成 GET）
  { variant: 'one-api', path: '/api/user/self', method: 'GET' },
]

async function queryRelay(cfg) {
  const base = (cfg.relayBase || '').replace(/\/+$/, '')
  if (!base) return { status: 'no-config', error: '未配置 relayBase', fetchedAt: Date.now() }
  if (!cfg.apiKey) return { status: 'no-key', error: '未配置 API Key', fetchedAt: Date.now() }

  let lastError = ''
  for (const ep of ENDPOINTS) {
    const url = base + ep.path + (typeof ep.query === 'function' ? '?' + ep.query() : '')
    const headers = { Accept: 'application/json', Authorization: `Bearer ${cfg.apiKey}` }
    if (ep.method === 'POST') headers['Content-Type'] = 'application/json'
    try {
      const res = await fetchWithTimeout(url, headers, cfg.timeoutMs || 8000, ep.method, ep.method === 'POST' ? {} : undefined)
      if (!res.ok) { lastError = `HTTP ${res.status} @ ${ep.path}`; continue }
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { lastError = `非 JSON 响应 @ ${ep.path}`; continue }
      const parsed = parseBalance(json, base)
      if (parsed) {
        return {
          status: 'ok',
          total: parsed.total,
          currency: parsed.currency,
          note: parsed.note,
          variant: parsed.variant,
          quotaLimit: parsed.quotaLimit ?? null,
          quotaUsed: parsed.quotaUsed ?? null,
          quotaRaw: (json.data && typeof json.data.quota === 'number') ? json.data.quota : null,
          error: null,
          fetchedAt: Date.now(),
          source: ep.path,
        }
      }
      lastError = `已认证但无余额字段 @ ${ep.path}（${json && json.message ? json.message : ''}）`
    } catch (e) {
      lastError = `${e && e.name === 'AbortError' ? '超时' : '网络错误'} @ ${ep.path}`
    }
  }
  return { status: 'no-balance-api', error: lastError || '所有端点均未开放余额查询', fetchedAt: Date.now() }
}

// ============================================================
// 内存缓存（stale-while-error：失败保留上一次成功值）
// ============================================================
const cache = {
  balance: null,      // 最后一次成功查询
  lastAttempt: null,  // 最近一次尝试（含失败）
  firstFetch: false,
}

async function refreshOnce() {
  const result = await queryRelay(runtimeConfig)
  cache.lastAttempt = result
  if (result.status === 'ok') {
    cache.balance = result
    cache.firstFetch = true
  }
  return result
}

let loopTimer = null
function startLoop() {
  stopLoop()
  const run = () => {
    if (!runtimeConfig.enabled) return
    refreshOnce().catch(() => {}).finally(() => {
      loopTimer = setTimeout(run, Math.max(1000, runtimeConfig.refreshIntervalMs || 30000))
    })
  }
  loopTimer = setTimeout(run, 0)
}
function stopLoop() {
  if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null }
}

// ============================================================
// 插件主体
// ============================================================
export async function apply(ctx) {
  // 首帧：先跑一次（不阻塞 apply），让 /rely/balances 第一次访问就有数据
  refreshOnce().catch(() => {})

  ctx.effect(() => {
    startLoop()
    return stopLoop
  }, 'dsh-rely: refresh loop')

  // HTTP 路由
  ctx.inject(['webServer'], (webCtx) => {
    const sendJson = (res, code, data) => {
      const body = JSON.stringify(data)
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    // 鉴权闸门（照抄官方看板 H-3 的结论：插件路由必须自己拦）
    let connectionSvc = null
    ctx.inject(['connection'], (c) => { connectionSvc = c.connection })
    const allowRequest = (req, res) => {
      const conn = connectionSvc
      if (!conn || typeof conn.requestRejection !== 'function') return true
      let rejection
      try { rejection = conn.requestRejection(req) } catch { rejection = undefined }
      if (rejection === undefined) return true
      res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(rejection === 401
        ? 'dsh web authentication required; reopen the URL printed by dsh web.\n'
        : 'forbidden\n')
      return false
    }

    // GET /rely/balances — 读缓存；?force=1 立即现拉（阻塞）；?stale=1 有缓存立刻回
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/rely/balances',
      async handler(req, res) {
        if (!allowRequest(req, res)) return
        if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
          res.writeHead(405, { Allow: 'GET, HEAD, POST' }); res.end(); return
        }
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        const force = req.method === 'POST' || params.get('force') === '1'
        if (force && cache.balance === null) await refreshOnce().catch(() => {})
        else if (force && Date.now() - (cache.lastAttempt?.fetchedAt || 0) < 1500) {
          // 强刷节流：1.5s 内只拉一次
        } else if (force) await refreshOnce().catch(() => {})

        const b = cache.balance
        sendJson(res, 200, {
          ok: true,
          // 客户端只看 ok 记录 + 最后尝试
          balance: b,
          lastAttempt: cache.lastAttempt,
          config: sanitizeConfigForClient(runtimeConfig),
          loading: !cache.firstFetch && b === null,
        })
      },
    }), 'dsh-rely: balances route')

    // GET/POST /rely/config —— 【必须同一个 handler】
    // 踩坑记录：kind:'exact' 同 path 注册两次会 throw「webserver: duplicate exact route」，
    // 而且异常会把这个 inject 作用域里的 effect 全部回滚 —— /rely/balances 会一起 404，
    // 整个插件看起来「加载成功但完全不工作」。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/rely/config',
      async handler(req, res) {
        if (!allowRequest(req, res)) return

        // ── GET：只读回当前配置（key 打码）──
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, { ok: true, config: sanitizeConfigForClient(runtimeConfig) })
          return
        }
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, HEAD, POST' }); res.end(); return }

        // ── POST：更新并持久化 ──
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch { /* 下面 400 */ }
        let patch
        try { patch = JSON.parse(body || '{}') } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' }); return
        }
        const next = { ...DEFAULT_CONFIG, ...runtimeConfig }
        // 写死字段：任何 patch 都改不动名字和地址
        next.relayName = RELAY_NAME_LOCKED
        next.relayBase = RELAY_BASE_LOCKED

        // key 锁死规则：
        //   'unchanged' / ''            → 保留原值（保存不会把 key 清空）
        //   非空新 key + 已锁定 + 未显式解锁 → 拒绝改（要换必须先点「更换 Key」）
        const incoming = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : null
        const wantUnlock = patch.unlockKey === true
        if (wantUnlock) next.keyLocked = false
        if (incoming && incoming !== 'unchanged') {
          if (!next.keyLocked || wantUnlock || next.keySource === 'credentials') {
            next.apiKey = incoming
            next.keyLocked = true
            next.keySource = 'saved'
          }
        }
        if (next.apiKey) next.keyLocked = true

        for (const k of ['refreshIntervalMs', 'clientPollIntervalMs', 'timeoutMs', 'safeThreshold', 'warnThreshold']) {
          if (typeof patch[k] === 'number' && isFinite(patch[k])) {
            next[k] = patch[k]
          }
        }
        next.refreshIntervalMs = Math.min(60000, Math.max(1000, next.refreshIntervalMs))
        next.clientPollIntervalMs = Math.min(3600000, Math.max(1000, next.clientPollIntervalMs))
        next.timeoutMs = Math.min(60000, Math.max(2000, next.timeoutMs))
        if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled

        // 落盘：保存后即锁死，重启后从 state.json 原样读回
        savePersisted(next)
        runtimeConfig = { ...next }
        startLoop()
        if (next.enabled) refreshOnce().catch(() => {})
        sendJson(res, 200, { ok: true, config: sanitizeConfigForClient(runtimeConfig) })
      },
    }), 'dsh-rely: config route')
  })
}

/** 发给客户端的配置视图：key 打码、不带内部字段；locked 字段告诉界面哪些是写死的 */
function sanitizeConfigForClient(cfg) {
  return {
    relayName: cfg.relayName,
    relayBase: cfg.relayBase,
    relayNameLocked: true,
    relayBaseLocked: true,
    // key 只回传打码预览，界面据此显示「已填/未填/已锁定」
    apiKeyMasked: maskKey(cfg.apiKey),
    hasKey: !!cfg.apiKey,
    keyLocked: !!cfg.keyLocked && !!cfg.apiKey,
    keySource: cfg.keySource || '',
    refreshIntervalMs: cfg.refreshIntervalMs,
    clientPollIntervalMs: cfg.clientPollIntervalMs,
    safeThreshold: cfg.safeThreshold,
    warnThreshold: cfg.warnThreshold,
    enabled: cfg.enabled,
  }
}
function maskKey(k) {
  if (!k) return ''
  const s = String(k)
  if (s.length <= 6) return '***'
  return s.slice(0, 3) + '…' + s.slice(-3)
}
