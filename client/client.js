/**
 * dsh-rely — 客户端半边（v0.1.1）
 *
 *  状态条独占一行，落在输入框下方那一排（token / 上下文条）的【下面】：
 *    [R] [绿萝] [$41.97] [三色灯]
 *  点击 → 设置面板（底部抽屉）：名字/地址只读（写死），key 保存后锁死。
 *
 *  数据源：GET /rely/balances（服务端定时缓存；?force=1 现拉）。
 */
window.__ModuleLoader__.load({
  id: "dsh-rely",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");

    //#region 文案
    const NS = "rely";
    const zh = {
      "title": "中转站余额",
      "status.ok": "正常", "status.warn": "偏低", "status.err": "异常",
      "status.nokey": "未配置 Key", "status.nobase": "未配置地址",
      "status.loading": "查询中", "status.noBalance": "未开放",
      "panel.title": "绿萝 · 余额设置",
      "field.key": "API Key", "field.keyHint": "保存后只存本地，界面显示打码",
      "field.site": "站点（已写死）",
      "field.name": "名字（已写死）",
      "field.base": "地址（已写死）",
      "field.locked": "🔒 已锁定",
      "field.keyLockedHint": "已锁死（{mask}）· 重启/刷新都不会变",
      "field.keyChange": "更换 Key",
      "field.keyNew": "新 Key（粘贴后保存）",
      "field.keyCancel": "取消",
      "lock.note": "key 已锁死：保存后落盘到本地状态文件，重启、刷新都不会变",
      "lock.auto": "未填 key，正在用 DSH 凭据里的 ZDXJL_API_KEY（同样是锁死来源）",
      "field.safe": "绿线阈值(USD)", "field.warn": "黄线阈值(USD)",
      "field.refresh": "服务端刷新(秒)", "field.poll": "前端轮询(秒)",
      "field.enabled": "启用状态条",
      "save": "保存并生效", "saved": "已保存 ✓", "saving": "保存中…",
      "refresh": "立即刷新", "refreshing": "刷新中…",
      "close": "关闭",
      "note.quota": "quota 折算系数 500000≈$1（未实测，仅供量级参考）",
      "note.newapi": "new-api available_balance 为美元",
      "note.openai": "OpenAI 兼容额度端点 total_available",
      "note.sub2api": "Sub2API /v1/usage · remaining 为钱包余额",
      "note.source": "数据源: {src}",
      "note.stale": "（失败中，显示为上次成功值）",
      "err.detail": "最近尝试: {msg}",
      "hint.tap": "点击打开设置",
    };
    const en = {
      "title": "Relay Balance",
      "status.ok": "OK", "status.warn": "Low", "status.err": "Error",
      "status.nokey": "No Key", "status.nobase": "No URL",
      "status.loading": "Loading", "status.noBalance": "No API",
      "panel.title": "Pothos · Balance Settings",
      "field.key": "API Key", "field.keyHint": "Stored locally; shown masked",
      "field.site": "Site (hard-coded)",
      "field.name": "Name (hard-coded)",
      "field.base": "URL (hard-coded)",
      "field.locked": "🔒 Locked",
      "field.keyLockedHint": "Locked ({mask}) · survives restart/refresh",
      "field.keyChange": "Replace key",
      "field.keyNew": "New key (paste then save)",
      "field.keyCancel": "Cancel",
      "lock.note": "Key is pinned: saved to the local state file, unchanged across restarts",
      "lock.auto": "No key stored — using ZDXJL_API_KEY from DSH credentials (also pinned)",
      "field.safe": "Green threshold (USD)", "field.warn": "Yellow threshold (USD)",
      "field.refresh": "Server refresh (sec)", "field.poll": "Client poll (sec)",
      "field.enabled": "Enable bar",
      "save": "Save", "saved": "Saved ✓", "saving": "Saving…",
      "refresh": "Refresh now", "refreshing": "Refreshing…",
      "close": "Close",
      "note.quota": "quota factor 500000≈$1 (unverified, order-of-magnitude only)",
      "note.newapi": "new-api available_balance is in USD",
      "note.openai": "OpenAI-compatible credit_grants total_available",
      "note.sub2api": "Sub2API /v1/usage · remaining = wallet balance",
      "note.source": "Source: {src}",
      "note.stale": "(showing last good value)",
      "err.detail": "Last attempt: {msg}",
      "hint.tap": "Tap to open settings",
    };
    //#endregion

    //#region store（单例轮询器 + 页面隐藏时暂停，同官方看板）
    const DEFAULT_POLL_MS = 30000;
    const FETCH_TIMEOUT_MS = 15000;
    let snapshot = { status: "loading", balance: null, lastAttempt: null, config: null };
    const listeners = new Set();
    let timer = null, pollMs = DEFAULT_POLL_MS, inflight = null, started = false, seq = 0, appliedSeq = 0;

    function notify() { for (const fn of [...listeners]) fn(); }
    const fetchT = (url, opts, ms) => {
      const timeout = typeof ms === "number" ? ms : FETCH_TIMEOUT_MS;
      try { return fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(timeout) }); }
      catch (e) { return fetch(url, opts); }
    };

    async function refresh(force = false, peek = false) {
      if (inflight !== null && !force && !peek) return inflight;
      if ((force || peek) && snapshot.isRefreshing !== true) {
        snapshot = { ...snapshot, isRefreshing: true }; notify();
      }
      inflight = (async () => {
        try {
          const url = peek ? "/rely/balances?stale=1"
            : force ? "/rely/balances?force=1"
            : "/rely/balances";
          const mySeq = ++seq;
          const res = await fetchT(url, { headers: { accept: "application/json" } });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          if (mySeq <= appliedSeq) { inflight = null; return; }
          appliedSeq = mySeq;
          if (data.config && typeof data.config.clientPollIntervalMs === "number" && data.config.clientPollIntervalMs >= 1000) {
            pollMs = Math.min(data.config.clientPollIntervalMs, 3600000);
          }
          snapshot = {
            status: "ok",
            balance: data.balance || null,
            lastAttempt: data.lastAttempt || null,
            config: data.config || snapshot.config,
            isRefreshing: false,
          };
        } catch (error) {
          snapshot = { ...snapshot, status: "error", message: String(error.message || error), isRefreshing: false };
        }
        inflight = null; notify();
      })();
      return inflight;
    }

    function schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (document.hidden) return;
        refresh().then(schedule, schedule);
      }, pollMs);
    }

    const store = {
      subscribe(fn) {
        listeners.add(fn);
        if (!started) { started = true; refresh(false, true).then(schedule, schedule); }
        return () => {
          listeners.delete(fn);
          if (listeners.size === 0) { started = false; if (timer !== null) { clearTimeout(timer); timer = null; } }
        };
      },
      getSnapshot() { return snapshot; },
      forceRefresh() { return refresh(true); },
    };
    //#endregion

    //#region 样式（独立 data-plugin-css 命名空间，不碰官方看板的）
    const CSS_ID = "dsh-rely/styles.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-rely";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = `
.rely_bar{display:inline-flex;align-items:center;gap:6px;font-size:12px;min-height:28px;box-sizing:border-box;
  padding:4px 12px;border-radius:999px;background:#f5f6f8;border:1px solid #e7e8ec;color:#777b84;
  cursor:pointer;white-space:nowrap;user-select:none;-webkit-tap-highlight-color:transparent}
.rely_bar:active{opacity:0.8}
.rely_bar_name{font-weight:700;color:#5a5e68;font-size:12px}
.rely_bar_amount{font-weight:800;font-variant-numeric:tabular-nums;color:#17181c;font-size:12px}
.rely_bar_amount.ok{color:#2e9e5b}
.rely_bar_amount.warn{color:#c8891a}
.rely_bar_amount.err{color:#d8443f}
/* 设置抽屉：与官方看板同一套遮罩坐标（z-index 99998/99999），同屏开两个时后开的在最上 */
.rely_scrim{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.35);overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.rely_scrim::-webkit-scrollbar{display:none}
.rely_drawer{position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:78vh;overflow-y:auto;
  background:#ffffff;border-radius:20px 20px 0 0;padding:16px 16px 24px;animation:rely-slideup .2s ease-out;
  box-shadow:0 -10px 40px rgba(0,0,0,0.12)}
@keyframes rely-slideup{from{transform:translateY(100%)}to{transform:translateY(0)}}
.rely_handle{width:36px;height:4px;border-radius:2px;background:#d7d8dc;margin:0 auto 14px}
.rely_head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.rely_head h3{margin:0;font-size:15px;font-weight:800;color:#17181c}
.rely_row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f0f1f4}
.rely_row:last-of-type{border-bottom:none}
.rely_row label{font-size:12px;font-weight:600;color:#5a5e68;flex:none}
.rely_input{flex:1;min-width:0;font-size:12px;padding:7px 9px;border-radius:9px;border:1px solid #e3e4e8;background:#fafafb;color:#17181c;font-family:inherit;box-sizing:border-box}
.rely_input:focus{outline:2px solid #4f7cff33;border-color:#4f7cff}
.rely_btn{border:none;cursor:pointer;font-family:inherit;border-radius:10px;font-weight:700}
.rely_btn_primary{width:100%;padding:11px 0;margin-top:14px;background:#4f7cff;color:#fff;font-size:13px}
.rely_btn_primary:active{opacity:0.85}
.rely_btn_ghost{background:#f0f1f4;color:#5a5e68;padding:8px 14px;font-size:12px}
.rely_err{color:#d8443f;background:#fdeceb;border-radius:10px;padding:9px 12px;font-size:11px;line-height:1.6;margin-top:10px}
/* ── 位置：注册在 conversation.input.dock，独占一行排在输入框（聊天栏）上面 ──
   ⚠️ 血泪教训：绝不许改宿主的 flex 属性。上一版给 dock 容器加了
   flex-wrap + order，把移动版那条「tok/s · 缓存命中 99%」状态条挤没了。
   这里只用咱们自己的类，父容器一个字节都不碰。 */
.rely_slotrow{display:flex;justify-content:center;width:100%;box-sizing:border-box;padding:0 var(--dsh-composer-side-clearance,0px)}
.rely_locktag{font-size:10px;font-weight:700;color:#6b7280;background:#eef0f3;border-radius:6px;padding:1px 6px;white-space:nowrap}
.rely_keybox{flex:1;min-width:0;display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.rely_keymasked{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#17181c;background:#fafafb;border:1px solid #e3e4e8;border-radius:9px;padding:6px 9px}
`;
      document.head.appendChild(tag);
    }
    //#endregion

    function levelOf(balance, cfg) {
      if (!balance || balance.status !== "ok") return "err";
      const t = cfg ? balance.total : 0;
      const safe = cfg && typeof cfg.safeThreshold === "number" ? cfg.safeThreshold : 1;
      const warn = cfg && typeof cfg.warnThreshold === "number" ? cfg.warnThreshold : 0.1;
      if (t > safe) return "ok";
      if (t > warn) return "warn";
      return "err";
    }

    function fmtAmount(balance) {
      if (!balance || balance.total == null) return "—";
      const n = balance.total;
      const sym = balance.currency === "USD" ? "$" : balance.currency === "CNY" ? "¥" : balance.currency + " ";
      const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
      return sym + n.toFixed(digits);
    }

    function BarReadout({ t, onOpen }) {
      const data = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const b = data.balance;
      const cfg = data.config;

      // 只画两样：中转站名字 + 余额。数字颜色本身就是状态灯
      // （绿=正常 / 黄=偏低 / 红=异常或没配 key），不再额外挂图标和小圆点。
      let amount, amtCls;
      if (!cfg || !cfg.hasKey) {
        amount = "未配置"; amtCls = "err";
      } else if (b && b.status === "ok") {
        const lv = levelOf(b, cfg);
        amount = fmtAmount(b);
        amtCls = lv === "ok" ? "ok" : lv === "warn" ? "warn" : "err";
      } else if (data.status === "error" || (data.lastAttempt && data.lastAttempt.status !== "ok")) {
        amount = "查询失败"; amtCls = "err";
      } else {
        amount = "查询中"; amtCls = "";
      }

      return react.createElement("span", {
        className: "rely_bar", onClick: onOpen, role: "button", tabIndex: 0,
        onKeyDown: (e) => { if (e.key === "Enter") onOpen(); },
        title: t("hint.tap"),
      }, [
        react.createElement("span", { className: "rely_bar_name", key: "name" }, (cfg && cfg.relayName) || "绿萝"),
        react.createElement("span", { className: "rely_bar_amount " + amtCls, key: "amount" }, amount),
      ]);
    }

    function Field({ t, label, children }) {
      return react.createElement("div", { className: "rely_row" }, [
        react.createElement("label", { key: "l" }, label),
        children,
      ]);
    }

    function SettingsDrawer({ t, open, onClose, config, onSaved }) {
      const data = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      // 名字 / 地址由服务端写死，界面只读展示，不存本地状态
      const [cfg, setCfg] = react.useState(config || null);
      const [key, setKey] = react.useState("");
      const [editingKey, setEditingKey] = react.useState(false);
      const [safe, setSafe] = react.useState((config && config.safeThreshold) ?? 1);
      const [warn, setWarn] = react.useState((config && config.warnThreshold) ?? 0.1);
      const [refreshSec, setRefreshSec] = react.useState(config ? Math.round(config.refreshIntervalMs / 1000) : 30);
      const [saving, setSaving] = react.useState(false);
      const [saved, setSaved] = react.useState(false);
      const [err, setErr] = react.useState("");

      // 打开时同步一次最新服务端配置
      react.useEffect(() => {
        if (!open) return;
        setKey(""); setEditingKey(false); setSaved(false); setErr("");
        fetch("/rely/config").then(r => r.json()).then(d => {
          if (!d || !d.ok) return;
          const c = d.config;
          setCfg(c);
          setSafe(c.safeThreshold ?? 1); setWarn(c.warnThreshold ?? 0.1);
          setRefreshSec(Math.round(c.refreshIntervalMs / 1000));
        }).catch(() => {});
      }, [open]);

      const view = data.config || cfg || config || null;
      const keyLocked = !!(view && view.keyLocked && view.hasKey);
      const hasKey = !!(view && view.hasKey);

      const save = async () => {
        setSaving(true); setSaved(false); setErr("");
        try {
          const r = await fetch("/rely/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // 空 key = 保留原值；'unchanged' = 保留原值
              apiKey: key === "" ? "unchanged" : key,
              // 已锁定时要换 key 必须先点「更换 Key」解开
              unlockKey: editingKey === true,
              safeThreshold: Number(safe), warnThreshold: Number(warn),
              refreshIntervalMs: Math.round(Number(refreshSec) * 1000),
              // 面板上已经没有开关了：永远保持启用，免得被历史配置卡成不刷新
              enabled: true,
            }),
          });
          const d = await r.json();
          if (d && d.ok) {
            setSaved(true);
            setCfg(d.config || cfg);
            setKey(""); setEditingKey(false);
            await store.forceRefresh();
            if (onSaved) onSaved();
          } else {
            setErr(t("err.detail").replace("{msg}", (d && d.error) || "save failed"));
          }
        } catch (e) { setErr(String((e && e.message) || e)); }
        setSaving(false);
      };

      if (!open) return null;
      const last = data.lastAttempt;
      const lastNote = last && last.status !== "ok" ? t("err.detail").replace("{msg}", last.error || "unknown") : "";

      return react.createElement(react.Fragment, null, [
        react.createElement("div", {
          className: "rely_scrim", key: "scrim",
          onClick: onClose,
          onTouchStart: (e) => { e.stopPropagation(); },
        }, null),
        react.createElement("div", { className: "rely_drawer", key: "drawer", role: "dialog", "aria-label": t("panel.title") }, [
          react.createElement("div", { className: "rely_handle", key: "handle" }),
          react.createElement("div", { className: "rely_head", key: "head" }, [
            react.createElement("h3", null, t("panel.title")),
            react.createElement("button", { className: "rely_btn rely_btn_ghost", onClick: onClose }, t("close")),
          ]),

          // 面板只留三样：key、刷新时间、阈值。名字/地址写死在服务端，不摆出来。
          // key：没填过可以粘贴；保存过就锁死，只读展示打码
          react.createElement(Field, { key: "f-key", label: t("field.key") },
            (keyLocked && !editingKey)
              ? react.createElement("div", { className: "rely_keybox" }, [
                  react.createElement("span", { className: "rely_keymasked", key: "m" }, (view && view.apiKeyMasked) || "sk-…"),
                  react.createElement("span", { className: "rely_locktag", key: "l" }, t("field.locked")),
                  react.createElement("button", {
                    className: "rely_btn rely_btn_ghost", key: "c", type: "button",
                    onClick: () => { setEditingKey(true); setKey(""); },
                  }, t("field.keyChange")),
                ])
              : react.createElement("div", { className: "rely_keybox" }, [
                  react.createElement("input", {
                    className: "rely_input", type: "password", value: key, key: "i",
                    onChange: (e) => setKey(e.target.value),
                    placeholder: hasKey ? "sk-…（留空 = 保留原 key）" : "sk-… 粘贴后保存",
                    autoComplete: "off",
                  }),
                  (keyLocked && editingKey) ? react.createElement("button", {
                    className: "rely_btn rely_btn_ghost", key: "x", type: "button",
                    onClick: () => { setEditingKey(false); setKey(""); },
                  }, t("field.keyCancel")) : null,
                ])
          ),
          react.createElement(Field, { key: "f-refresh", label: t("field.refresh") },
            react.createElement("input", { className: "rely_input", type: "number", min: "1", max: "60", value: refreshSec, onChange: (e) => setRefreshSec(e.target.value) })
          ),
          react.createElement(Field, { key: "f-safe", label: t("field.safe") },
            react.createElement("input", { className: "rely_input", type: "number", step: "0.01", value: safe, onChange: (e) => setSafe(e.target.value) })
          ),
          react.createElement(Field, { key: "f-warn", label: t("field.warn") },
            react.createElement("input", { className: "rely_input", type: "number", step: "0.01", value: warn, onChange: (e) => setWarn(e.target.value) })
          ),

          // 只在出问题时给一行人话，平时不摆任何多余信息
          (lastNote || err) ? react.createElement("div", { className: "rely_err", key: "err" }, err || lastNote) : null,

          react.createElement("button", {
            className: "rely_btn rely_btn_primary", key: "save",
            disabled: saving, onClick: save,
          }, saving ? t("saving") : saved ? t("saved") : t("save")),
        ]),
      ]);
    }

    //#region plugin
    const inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(() => { try { ctx.locale.register(NS, { zh, en }); } catch (e) {} }, "dsh-rely: dictionaries");

      // 槽位 = conversation.input.dock：它的容器是 display:contents，我们的行会变成
      // composerStack（flex column）的直接子项，而 composerStack 在 DOM 里排在输入框前面
      // —— 所以这条就是「聊天栏（输入框）上面」那一行。
      // order 不设（=0）：DOM 顺序已经保证在输入框之前；设大了反而会掉到输入框下面。
      ctx.slots.inject("conversation.input.dock", () => {
        const dispose = ctx.slots.register({
          name: "conversation.input.dock",
          id: "dsh-rely",
          locale: NS,
        }, function RelySlot(props) {
          const t = props.t;
          const [open, setOpen] = react.useState(false);
          const data = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
          // 只渲染一条：名字 + 余额（点开是设置抽屉）
          return react.createElement("div", { className: "rely_slotrow" }, [
            react.createElement(BarReadout, { t, onOpen: () => setOpen(true), key: "bar" }),
            react.createElement(SettingsDrawer, {
              t, open, onClose: () => setOpen(false),
              config: data.config, key: "drawer",
            }),
          ]);
        });
        return () => { dispose(); };
      });

      // 切回前台立即刷新一次
      ctx.effect(() => {
        const onVisibility = () => { if (!document.hidden) refresh(false, true).then(schedule, schedule); };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
      }, "dsh-rely: visibility resume");
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
