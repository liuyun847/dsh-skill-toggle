// 浏览器端插件主体：在「设置 → 技能开关」里给**每个技能一个开关**。
//
// 数据来源是宿主半身（lib/index.js）注册的精确 Fetch 路由 `/api/skill-toggle/state`：
//   · GET  → 状态文件三态 + 生效名单 + **含被禁技能**的完整技能目录；
//   · POST → { name, enabled }，由宿主读-改-写状态文件（不用页面副本覆盖宿主，避免竞态）。
// 这条路由挂在共享 `/api` 通道上，所以自带浏览器信任栅栏与会话 cookie 鉴权 ——
// 本插件不自己实现鉴权、也不开公开路由。
//
// 契约（照 DSH 客户端插件格式）：
//   · `window.__ModuleLoader__.load({ id, factory })`，id 必须等于包名；
//   · factory 里 `require('react')`（React 由浏览器模块表提供，不重复安装）；
//   · 导出 `apply(ctx)` 与 `inject`（服务名列表）。
// 纪律：不 import 任何宿主/客户端包（本包以 Junction 落进 profile，裸 import 会 ERR_MODULE_NOT_FOUND），
// 只用模块表给的 react；样式只用 `--dsw-*` 主题令牌，容器与控件跟着宿主主题走。
window.__ModuleLoader__.load({
  id: 'dsh-skill-toggle',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    /** 设置页导航键（`settings.section` 的 id；勿改，它是页面寻址键）。 */
    var SECTION_ID = 'skill-toggle'
    /** 导航里的排序（宿主自带：general 0 / models 10 / plugins 15 / agent-presets 20）。 */
    var SECTION_ORDER = 30
    /** locale 命名空间。 */
    var NS = 'skill-toggle'
    /** 宿主状态接口（见 lib/index.js 的 STATE_ROUTE，两处必须一致）。 */
    var ROUTE = '/api/skill-toggle/state'

    // ── 文案：走客户端 locale 服务；拿不到 locale 服务时用 zh 兜底 ──────────────
    /** English copy. */
    var en = {
      nav: 'Skill switches',
      title: 'Skill switches',
      intro: 'A switched-off skill disappears from the model skill catalog (<available_skills>), from the skill tool, and from the /name gesture. It is restored by switching it back on.',
      summary: '{total} skills · {off} switched off',
      refresh: 'Refresh',
      loading: 'Reading…',
      empty: 'No skills were found.',
      unknownGroup: 'Named in the list but not present now',
      unknownNote: 'No such skill right now (the name is kept so it stays off if it comes back)',
      on: 'on',
      off: 'off',
      switchAria: '{name}：{state}',
      corrupt: 'The state file is unreadable, so this page is read-only. Fix or rename it first — writing would erase the list inside it.',
      missing: 'The state file does not exist yet; every skill is currently on. The first switch creates it.',
      incomplete: 'This catalog is incomplete (the host reported complete=false), so entries may be missing.',
      dropped: '{count} entries in the state file are not valid skill names and were ignored.',
      failed: 'Could not read the switches',
      retry: 'Retry',
      routeMissing: 'The host never registered {route} (HTTP 404). Check the plugin log for the line "设置页状态接口已注册" — if it is missing, the host half could not reach ctx.connection.fetch.',
      foot: 'Changes are written to {path} and take effect on the next model step — no restart needed.',
    }
    /** Simplified Chinese copy. */
    var zh = {
      nav: '技能开关',
      title: '技能开关',
      intro: '关掉的技能会从模型看到的技能目录（<available_skills>）、`skill` 工具与 `/名字` 手势里一起消失；再打开即恢复。技能文件本身一个字都不动。',
      summary: '共 {total} 个技能 · 已关 {off} 个',
      refresh: '刷新',
      loading: '正在读取…',
      empty: '没有发现任何技能。',
      unknownGroup: '名单里有、当前不存在',
      unknownNote: '当前没有这个技能（名字保留着：以后装回来就已经是关的）',
      on: '已开启',
      off: '已关闭',
      switchAria: '{name}：{state}',
      corrupt: '状态文件读不出来，本页只能看不能改。请先修好它或改名/删除 —— 覆盖写等于把里面的名单清空。',
      missing: '状态文件还不存在，当前所有技能都是开的；拨第一个开关时才会创建它。',
      incomplete: '这次技能目录不完整（宿主回报 complete=false），列表可能缺项。',
      dropped: '状态文件里有 {count} 条不是合法技能名的条目，已被忽略。',
      failed: '读不到开关状态',
      retry: '重试',
      routeMissing: '宿主没挂上 {route}（HTTP 404）—— 去看插件日志里有没有「设置页状态接口已注册」这一行；没有就是宿主半身没拿到 ctx.connection.fetch。',
      foot: '改动写入 {path}，在下一个模型步骤生效，不需要重启。',
    }

    // ── 样式：只用宿主主题令牌（`--dsw-*`），字号/圆角/分隔线照宿主设置页的写法 ──
    var CSS = [
      '.dst_page{box-sizing:border-box;width:100%;flex-direction:column;color:var(--dsw-alias-label-primary);display:flex}',
      '.dst_head{padding:4px 0 14px}',
      '.dst_title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.dst_intro{color:var(--dsw-alias-label-secondary);margin:6px 0 0;font-size:12px;line-height:18px}',
      '.dst_toolbar{justify-content:space-between;align-items:center;gap:16px;padding:0 0 10px;display:flex}',
      '.dst_status{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}',
      '.dst_refresh{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;background:0 0;flex:none;padding:0 10px}',
      '.dst_refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dst_refresh:disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}',
      '.dst_refresh:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dst_banner{border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-business-primary)) 12%, transparent);color:var(--dsw-alias-label-primary);margin:0 0 10px;padding:8px 12px;font-size:12px;line-height:18px}',
      '.dst_error{color:var(--dsw-alias-state-error-primary);align-items:center;gap:10px;margin:0;padding:4px 0 10px;font-size:12px;line-height:18px;display:flex}',
      '.dst_list{flex-direction:column;margin:0;padding:0;list-style:none;display:flex}',
      '.dst_row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:12px 0;display:flex}',
      '.dst_rowMain{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}',
      '.dst_nameRow{align-items:baseline;gap:8px;min-width:0;display:flex}',
      '.dst_name{font-size:14px;line-height:20px;overflow-wrap:anywhere}',
      '.dst_provider{color:var(--dsw-alias-label-caption);flex:none;font-size:11px;line-height:16px}',
      '.dst_desc{color:var(--dsw-alias-label-secondary);-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:18px;display:-webkit-box;overflow:hidden}',
      '.dst_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dst_off .dst_name,.dst_off .dst_desc{color:var(--dsw-alias-label-tertiary)}',
      '.dst_switch{border:0;border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;flex:none;align-items:center;padding:4px;display:inline-flex}',
      '.dst_switch:disabled{cursor:not-allowed}',
      '.dst_switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dst_track{background:var(--dsw-alias-border-l2);border-radius:8px;width:32px;height:16px;transition:background-color .12s;flex:none;display:inline-block;position:relative}',
      '.dst_thumb{background:var(--dsw-alias-bg-layer-1);border-radius:50%;width:12px;height:12px;transition:transform .12s;position:absolute;top:2px;left:2px}',
      '.dst_track[data-on=true]{background:var(--dsw-alias-state-business-primary)}',
      '.dst_track[data-on=true] .dst_thumb{transform:translate(16px)}',
      '.dst_switch:disabled .dst_track{opacity:.5}',
      '.dst_empty{color:var(--dsw-alias-label-tertiary);margin:0;padding:16px 0;font-size:13px;line-height:20px}',
      '.dst_foot{color:var(--dsw-alias-label-caption);margin:0;padding:14px 0 0;font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '@media (prefers-reduced-motion:reduce){.dst_track,.dst_thumb{transition:none}}',
    ].join('')

    /** 组件根上的样式表：随组件卸载一起消失（不往 document.head 里塞东西）。 */
    function StyleSheet() {
      return h('style', { 'data-dsh-skill-toggle': '' }, CSS)
    }

    // ── 数据访问：两个函数都**永不 reject**，失败折成 { ok:false, error, status } ──
    /** 把响应体折成 `{ ok, state }` / `{ ok, error, status }`。 */
    function normalize(body, status) {
      if (body !== null && typeof body === 'object' && body.ok === true) return { ok: true, state: body }
      var message = body !== null && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : 'HTTP ' + String(status)
      return { ok: false, error: message, status: status }
    }

    /** 发一次请求并归一化结果。 */
    function request(init) {
      return fetch(ROUTE, init).then(
        function (response) {
          // 404 单独认出来：这是"宿主根本没挂上这条路由"的签名（未鉴权是 401，路径写错也是 404）。
          // 比"响应不是 JSON"有用得多 —— 页面能直说去看哪一行日志。2026-09-28 实测就是这条。
          if (response.status === 404) return { ok: false, error: 'HTTP 404', status: 404 }
          return response.json().then(
            function (body) { return normalize(body, response.status) },
            function () {
              return {
                ok: false,
                error: 'HTTP ' + String(response.status) + '：响应不是 JSON',
                status: response.status,
              }
            },
          )
        },
        function (cause) {
          return { ok: false, error: '请求失败：' + String((cause && cause.message) || cause), status: 0 }
        },
      )
    }

    /** 给用户看的错误文案：404 换成可操作的那一句。 */
    function describeError(result, t) {
      if (result !== null && typeof result === 'object' && result.status === 404) {
        return t('routeMissing', { route: ROUTE })
      }
      if (result !== null && typeof result === 'object' && typeof result.error === 'string') return result.error
      return String(result)
    }

    /** 读一次快照。 */
    function readState() {
      return request({ method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' })
    }

    /** 改一个技能：由宿主读-改-写状态文件，返回改完的新快照。 */
    function writeToggle(name, enabled) {
      return request({
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name, enabled: enabled }),
      })
    }

    /** 浅拷贝 state 并改掉名单里的一个名字（乐观更新用）。 */
    function withToggled(state, name, enabled) {
      var disabled = state.disabled.slice()
      var index = disabled.indexOf(name)
      if (enabled) {
        if (index >= 0) disabled.splice(index, 1)
      } else if (index < 0) {
        disabled.push(name)
        disabled.sort()
      }
      var next = {}
      for (var key in state) if (Object.prototype.hasOwnProperty.call(state, key)) next[key] = state[key]
      next.disabled = disabled
      return next
    }

    /** 拷贝一份 busy 表并改掉一个键（`value:false` 即删除该键）。 */
    function withBusy(current, name, value) {
      var next = {}
      for (var key in current) if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key]
      if (value) next[name] = true
      else delete next[name]
      return next
    }

    /**
     * 把宿主快照折成要渲染的行：目录里的技能 + 名单里多出来的陌生名字，按名字排序。
     *
     * 陌生名字也要成行 —— 否则用户没法把一个"当前不存在但名单里有"的名字清掉。
     * 纯函数（不碰 React），单测直接覆盖。
     */
    function buildRows(snapshot) {
      var disabledSet = {}
      var index
      for (index = 0; index < snapshot.disabled.length; index += 1) disabledSet[snapshot.disabled[index]] = true
      var rows = []
      for (index = 0; index < snapshot.skills.length; index += 1) {
        var skill = snapshot.skills[index]
        rows.push({
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : '',
          whenToUse: typeof skill.whenToUse === 'string' ? skill.whenToUse : '',
          provider: typeof skill.provider === 'string' ? skill.provider : '',
          enabled: disabledSet[skill.name] !== true,
        })
      }
      for (index = 0; index < snapshot.disabled.length; index += 1) {
        var name = snapshot.disabled[index]
        var known = false
        for (var inner = 0; inner < snapshot.skills.length; inner += 1) {
          if (snapshot.skills[inner].name === name) { known = true; break }
        }
        if (!known) rows.push({ name: name, description: '', whenToUse: '', provider: '', enabled: false, unknown: true })
      }
      rows.sort(function (left, right) {
        if (left.name === right.name) return 0
        return left.name < right.name ? -1 : 1
      })
      return rows
    }

    /** 一个开关：`role="switch"` + `aria-checked`，轨道/滑块照宿主同类控件。 */
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'dst_switch',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        disabled: props.disabled === true,
        title: props.label,
        onClick: props.onToggle,
      }, h('span', {
        className: 'dst_track',
        'data-on': props.checked ? true : undefined,
        'aria-hidden': 'true',
      }, h('span', { className: 'dst_thumb' })))
    }

    /** 一行技能：名字 + 来源 + 描述 + 右侧开关。 */
    function SkillRow(props) {
      var row = props.row
      var state = row.enabled ? props.t('on') : props.t('off')
      // 正文优先 description；只写了 whenToUse 的技能（frontmatter 两种写法都合法）也要有话说。
      var text = row.description !== '' ? row.description : row.whenToUse
      return h('li', { className: row.enabled ? 'dst_row' : 'dst_row dst_off' },
        h('div', { className: 'dst_rowMain' },
          h('div', { className: 'dst_nameRow' },
            h('span', { className: 'dst_name' }, row.name),
            row.provider === '' ? null : h('span', { className: 'dst_provider' }, row.provider)),
          row.unknown === true
            ? h('div', { className: 'dst_note' }, props.t('unknownNote'))
            : (text === '' ? null : h('div', { className: 'dst_desc' }, text))),
        h(Switch, {
          checked: row.enabled,
          disabled: props.disabled === true || props.busy === true,
          label: props.t('switchAria', { name: row.name, state: state }),
          onToggle: function () { props.onToggle(row.name, !row.enabled) },
        }))
    }

    /**
     * 设置页的「技能开关」整页。
     *
     * 状态机：`loading` → `data`（快照）/ `error`（读不到）。开关点击是**乐观更新**：
     * 先按用户意图改本地名单（下一帧就动），服务端回来再对齐；失败则重新拉一次权威快照回退。
     * 行级 busy 只用来禁用那一个开关，不阻塞整页。
     */
    function SkillToggleSection(props) {
      var t = typeof props.t === 'function'
        ? props.t
        : function (key, params) {
          var template = zh[key] !== undefined ? zh[key] : key
          if (params === undefined || params === null) return template
          return template.replace(/\{(\w+)\}/g, function (match, name) {
            return params[name] !== undefined ? String(params[name]) : match
          })
        }

      var dataState = react.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errorState = react.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var loadingState = react.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var busyState = react.useState({})
      var busy = busyState[0]
      var setBusy = busyState[1]
      /** 组件是否还挂着：异步回来的 setState 落在已卸载组件上会被 React 警告。 */
      var alive = react.useRef(true)

      react.useEffect(function () {
        alive.current = true
        return function () { alive.current = false }
      }, [])

      var load = react.useCallback(function () {
        setLoading(true)
        readState().then(function (result) {
          if (!alive.current) return
          if (result.ok) {
            setData(result.state)
            setError(null)
          } else {
            setError(result)
          }
          setLoading(false)
        })
      }, [])

      react.useEffect(function () { load() }, [load])

      function toggle(name, enabled) {
        setBusy(function (current) { return withBusy(current, name, true) })
        setData(function (current) { return current === null ? current : withToggled(current, name, enabled) })
        writeToggle(name, enabled).then(function (result) {
          if (!alive.current) return
          if (result.ok) {
            setData(result.state)
            setError(null)
            setBusy(function (current) { return withBusy(current, name, false) })
            return
          }
          // 失败：本地那份已经不权威，直接重新拉一次回退，并留下错误行。
          setError(result)
          readState().then(function (fresh) {
            if (!alive.current) return
            if (fresh.ok) setData(fresh.state)
            setBusy(function (current) { return withBusy(current, name, false) })
          })
        })
      }

      var rows = data === null ? [] : buildRows(data)
      var writable = data !== null && data.writable !== false
      var children = [h(StyleSheet, { key: 'style' })]

      children.push(h('div', { className: 'dst_head', key: 'head' },
        h('h2', { className: 'dst_title' }, t('title')),
        h('p', { className: 'dst_intro' }, t('intro'))))

      children.push(h('div', { className: 'dst_toolbar', key: 'toolbar' },
        h('span', { className: 'dst_status' }, loading && data === null
          ? t('loading')
          : t('summary', { total: rows.length, off: data === null ? 0 : data.disabled.length })),
        h('button', {
          type: 'button',
          className: 'dst_refresh',
          disabled: loading,
          onClick: load,
        }, t('refresh'))))

      if (error !== null) {
        children.push(h('p', { className: 'dst_error', key: 'error' },
          t('failed') + '：' + describeError(error, t),
          h('button', { type: 'button', className: 'dst_refresh', onClick: load }, t('retry'))))
      }
      if (data !== null && data.status === 'corrupt') {
        children.push(h('p', { className: 'dst_banner', key: 'corrupt' }, t('corrupt') + '（' + String(data.detail) + '）'))
      }
      if (data !== null && data.status === 'missing') {
        children.push(h('p', { className: 'dst_banner', key: 'missing' }, t('missing')))
      }
      if (data !== null && data.complete === false) {
        children.push(h('p', { className: 'dst_banner', key: 'incomplete' }, t('incomplete')))
      }
      if (data !== null && data.skillsError !== null && data.skillsError !== undefined) {
        children.push(h('p', { className: 'dst_banner', key: 'skillsError' }, String(data.skillsError)))
      }
      if (data !== null && Array.isArray(data.dropped) && data.dropped.length > 0) {
        children.push(h('p', { className: 'dst_banner', key: 'dropped' }, t('dropped', { count: data.dropped.length })))
      }

      if (rows.length === 0) {
        children.push(h('p', { className: 'dst_empty', key: 'empty' }, loading ? t('loading') : t('empty')))
      } else {
        children.push(h('ul', { className: 'dst_list', key: 'list' }, rows.map(function (row) {
          return h(SkillRow, {
            key: row.name,
            row: row,
            t: t,
            busy: busy[row.name] === true,
            disabled: !writable,
            onToggle: toggle,
          })
        })))
      }

      if (data !== null && typeof data.stateFile === 'string') {
        children.push(h('p', { className: 'dst_foot', key: 'foot' }, t('foot', { path: data.stateFile })))
      }

      return h('div', { className: 'dst_page' }, children)
    }

    // ── 注册：设置页里新增一节 ────────────────────────────────────────────────
    /** 依赖服务（slots 由 client-runtime 提供）。locale 走 ctx.get 软取，缺席时用内置 zh 兜底。 */
    var inject = ['slots']

    /**
     * 客户端插件主体：把「技能开关」注册进 `settings.section`（设置页里一整页）。
     *
     * 注册选项里带 `locale: NS` ⇒ 组件 props 会多一个已绑定本命名空间的 `t`。
     * 拿不到 locale 服务时**不声明 locale**（声明了却没人渲染会出错），改用内置 zh。
     */
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[skill-toggle] 拿不到 slots 服务，设置页开关未注册')
        return
      }
      var locale = ctx.get('locale')
      var bound = locale !== undefined && typeof locale.bind === 'function' && typeof locale.register === 'function'
        ? locale.bind(NS)
        : undefined
      if (bound !== undefined) {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }) }, 'skill-toggle: 设置页文案')
      }
      var options = { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER }
      if (bound !== undefined) {
        options.locale = NS
        options.label = function () { return bound('nav') }
      } else {
        options.label = zh.nav
      }
      slots.inject('settings.section', function () { return slots.register(options, SkillToggleSection) })
    }

    exports.apply = apply
    exports.inject = inject
    // 测试钩子：纯函数（浏览器侧不消费）。React 渲染路径没法在 Node 里离线跑
    // （本机没有可 require 的 react 包，React 是打进 web 前端产物里的），
    // 所以把"能纯函数化的判定"抽到这里，由 test/client-module.test.mjs 直接覆盖。
    exports.__test = {
      normalize: normalize,
      describeError: describeError,
      withToggled: withToggled,
      withBusy: withBusy,
      buildRows: buildRows,
      route: ROUTE,
      sectionId: SECTION_ID,
      dictionaries: { zh: zh, en: en },
    }
    return module.exports
  },
})
