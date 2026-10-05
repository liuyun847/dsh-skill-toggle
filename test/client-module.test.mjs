/**
 * 浏览器半身（`lib/client.js`）的离线测试。
 *
 * 能测什么、不能测什么，写清楚：
 *  · **能**：模块按 `window.__ModuleLoader__.load` 契约注册、id 等于包名、factory 产出
 *    `apply`/`inject`、注册选项（座位名/id/order/label/locale）正确、locale 缺席时的降级、
 *    以及抽出来的**纯函数**（快照归一化、乐观更新、行合成）；
 *  · **不能**：真正的 React 渲染。本机没有可 `require` 的 react 包（React 是打进 web 前端
 *    产物里的，模块表在浏览器里才给），所以渲染路径只能靠重启后在页面里验收。
 *    这里用一个最小 React 桩让 factory 跑完，够用来钉住"注册形状"。
 *
 * 另一条硬约束：`lib/client.js` 里写的路由常量必须与宿主半身的 `STATE_ROUTE` **完全一致** ——
 * 两处漂了就是"页面读不到、日志里也看不出为什么"，所以下面直接对着宿主导出比。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATE_ROUTE } from '../lib/index.js'

/** 最小 React 桩：factory 只会**引用**这些成员，组件体不会在离线测试里执行。 */
const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
}

/**
 * 造一个 `window.__ModuleLoader__` 桩并加载浏览器半身。
 * @returns {Promise<{ definition: object, exports: object }>}
 */
async function loadClientModule() {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
  }
  // 动态 import：`window` 必须先挂上（模块顶层就会调 __ModuleLoader__.load）。
  await import(`../lib/client.js?cachebust=${Date.now()}`)
  assert.ok(captured.definition !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load')
  const exports = captured.definition.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`离线测试没有准备模块 ${id}`)
  })
  return { definition: captured.definition, exports }
}

test('浏览器半身：按模块表契约注册，id 等于包名', async () => {
  const { definition, exports } = await loadClientModule()
  assert.equal(definition.id, 'dsh-skill-toggle')
  assert.equal(typeof definition.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('浏览器半身：路由常量与宿主半身的 STATE_ROUTE 完全一致（两处漂了页面就读不到）', async () => {
  const { exports } = await loadClientModule()
  assert.equal(exports.__test.route, STATE_ROUTE)
  assert.equal(exports.__test.sectionId, 'skill-toggle')
})

test('浏览器半身：zh / en 两份文案键集必须一致（漏一条就是某种语言下露出 key）', async () => {
  const { exports } = await loadClientModule()
  const { zh, en } = exports.__test.dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('apply：注册进 settings.section，带 locale 时把 label 交给已绑定命名空间的 t', async () => {
  const { exports } = await loadClientModule()
  const calls = { injected: [], registered: [], localeNs: null, effects: 0 }
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject(key, callback) { calls.injected.push(key); return callback() },
          register(options, component) { calls.registered.push({ options, component }); return () => {} },
        }
      }
      if (name === 'locale') {
        return {
          bind(ns) { calls.localeNs = ns; return (key) => `${ns}:${key}` },
          register(ns, dicts) { calls.localeNs = ns; calls.dicts = dicts; return () => {} },
        }
      }
      return undefined
    },
    effect(callback) { calls.effects += 1; return callback() },
  }

  exports.apply(ctx)

  assert.deepEqual(calls.injected, ['settings.section'])
  assert.equal(calls.registered.length, 1)
  const { options, component } = calls.registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'skill-toggle')
  assert.equal(options.order, 30)
  assert.equal(options.locale, 'skill-toggle')
  assert.equal(typeof component, 'function')
  assert.equal(options.label(), 'skill-toggle:nav', 'label 必须走 locale（随语言切换）')
  assert.deepEqual(Object.keys(calls.dicts).sort(), ['en', 'zh'])
  assert.equal(calls.effects, 1, '字典注册必须包在 ctx.effect 里（随插件卸载回收）')
})

test('apply：拿不到 locale 服务时不声明 locale，label 退化成中文常量', async () => {
  const { exports } = await loadClientModule()
  let registered
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject(key, callback) { return callback() },
          register(options, component) { registered = { options, component }; return () => {} },
        }
      }
      return undefined
    },
    effect(callback) { return callback() },
  }

  exports.apply(ctx)

  assert.equal(registered.options.locale, undefined, 'locale 服务缺席时不能声明 locale（声明了没人渲染）')
  assert.equal(registered.options.label, '技能开关')
})

test('apply：拿不到 slots 服务时只告警、不抛错', async () => {
  const { exports } = await loadClientModule()
  assert.doesNotThrow(() => exports.apply({ get: () => undefined, effect: (cb) => cb() }))
})

test('纯函数 normalize / describeError：ok / 业务错误 / 非 JSON 响应三条路都折成统一形状', async () => {
  const { exports } = await loadClientModule()
  const { normalize, describeError } = exports.__test
  const t = (key, params) => (params === undefined ? key : `${key}(${params.route})`)

  assert.equal(normalize({ ok: true, skills: [] }, 200).ok, true)
  assert.deepEqual(normalize({ ok: false, error: '状态文件损坏' }, 409), {
    ok: false,
    error: '状态文件损坏',
    status: 409,
  })
  assert.deepEqual(normalize('not json', 500), { ok: false, error: 'HTTP 500', status: 500 })
  assert.deepEqual(normalize(null, 404), { ok: false, error: 'HTTP 404', status: 404 })

  // 404 是最容易被误读成"响应坏了"的那一种，必须换成可操作的那句（2026-09-28 实测踩过）。
  assert.equal(describeError({ ok: false, error: 'HTTP 404', status: 404 }, t), 'routeMissing(/api/skill-toggle/state)')
  assert.equal(describeError({ ok: false, error: '状态文件损坏', status: 409 }, t), '状态文件损坏')
  assert.equal(describeError('裸字符串', t), '裸字符串')
})

test('纯函数 withToggled / withBusy：乐观更新与行级忙标记都不改原对象', async () => {
  const { exports } = await loadClientModule()
  const { withToggled, withBusy } = exports.__test

  const before = { disabled: ['beta-skill'], skills: [], status: 'ok' }
  const added = withToggled(before, 'alpha-skill', false)
  assert.deepEqual(added.disabled, ['alpha-skill', 'beta-skill'], '关掉时插入并排序')
  assert.deepEqual(before.disabled, ['beta-skill'], '原对象不能被改（React 靠新引用重渲）')

  const removed = withToggled(before, 'beta-skill', true)
  assert.deepEqual(removed.disabled, [])
  assert.equal(withToggled(before, 'ghost-skill', true).disabled.length, 1, '打开一个不在名单里的名字是空操作')

  assert.deepEqual(withBusy({}, 'alpha-skill', true), { 'alpha-skill': true })
  assert.deepEqual(withBusy({ 'alpha-skill': true }, 'alpha-skill', false), {})
  assert.deepEqual(withBusy({ 'alpha-skill': true }, 'beta-skill', true), { 'alpha-skill': true, 'beta-skill': true })
})

test('纯函数 buildRows：目录 + 名单合成行，被禁的也要在列表里，陌生名字单列一行', async () => {
  const { exports } = await loadClientModule()
  const { buildRows } = exports.__test

  const rows = buildRows({
    disabled: ['beta-skill', 'ghost-skill'],
    skills: [
      { name: 'beta-skill', description: '测试用技能 beta。', provider: 'filesystem' },
      { name: 'alpha-skill', description: '', whenToUse: '只在 alpha 场景用', provider: 'filesystem' },
    ],
  })

  assert.deepEqual(rows.map((row) => row.name), ['alpha-skill', 'beta-skill', 'ghost-skill'], '按名字排序')
  assert.equal(rows[0].enabled, true)
  assert.equal(rows[0].whenToUse, '只在 alpha 场景用', 'description 为空时靠 whenToUse 兜底')
  assert.equal(rows[1].enabled, false, '被禁技能必须出现在列表里（否则打不开）')
  assert.equal(rows[2].unknown, true, '名单里的陌生名字也要成行（否则清不掉）')
  assert.equal(rows[2].enabled, false)

  // 缺字段的快照不能把渲染搞崩。
  assert.deepEqual(buildRows({ disabled: [], skills: [{ name: 'solo' }] }), [
    { name: 'solo', description: '', whenToUse: '', provider: '', enabled: true },
  ])
})
