/**
 * v0.3.0 设置页 UI 的宿主侧：状态接口（`/api/skill-toggle/state`）、
 * 完整目录读取（`readFullCatalog`）与共用写路径（`toggleDisabledName`）。
 *
 * 三条纪律沿用既有测试：
 *  1. 真家伙 —— 真实 `Context` + 真实 `SkillRegistry` + 真实 `dsh-skill-filesystem`；
 *  2. `connection` 服务是**假**的（只为捕获注册进来的路由），因为真实那条要浏览器 cookie；
 *  3. 一切落盘都在临时目录里，绝不碰真实的 `~\.dsh\dsh-skill-toggle.json` 与 `~\.dsh\skills\`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness, waitUntil } from './helpers.mjs'
import { readFullCatalog, readStateFile, toggleDisabledName } from '../lib/index.js'

/** 造一个临时工作目录。 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggle-ui-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 目录里有没有这条技能。 */
function has(skills, name) {
  return skills.some((entry) => entry.name === name)
}

/**
 * 起一套带**假 connection 服务**的 harness：捕获插件注册进来的路由，便于直接调它的 `fetch`。
 *
 * 为什么能这么测：路由处理器只依赖 `Request`/`Response` 与插件上下文，鉴权与信任栅栏在
 * `connection` 内部完成（那部分属于宿主，不是本插件的责任）。
 */
async function createUiHarness(options = {}) {
  const captured = { route: undefined, registrations: 0, disposed: 0 }
  const base = await createHarness({
    ...options,
    beforeToggle: async ({ root }) => {
      const dispose = root.provide('connection', {
        fetch: {
          register(route) {
            captured.registrations += 1
            captured.route = route
            return () => {
              captured.route = undefined
              captured.disposed += 1
            }
          },
        },
      })
      return { dispose }
    },
  })
  return {
    ...base,
    captured,
    /** 调一次状态接口（`init` 省略即 GET）。 */
    async call(path = '/api/skill-toggle/state', init = { method: 'GET' }) {
      assert.ok(captured.route !== undefined, '插件应当已经把状态接口注册进 connection.fetch')
      const response = await captured.route.fetch(new Request(`http://127.0.0.1:3080${path}`, init))
      return { response, body: await response.json() }
    },
    /** POST 一个开关。 */
    async toggle(name, enabled) {
      return await this.call('/api/skill-toggle/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, enabled }),
      })
    },
    async cleanupAll() {
      base.before.dispose()
      await base.cleanup()
    },
  }
}

test('状态接口：注册进 connection.fetch，路径/方法/请求体模式都符合 /api 通道约束', async (t) => {
  const h = await createUiHarness()
  t.after(() => h.cleanupAll())

  assert.equal(h.captured.registrations, 1, '只注册一次')
  const route = h.captured.route
  assert.equal(route.path, '/api/skill-toggle/state')
  assert.deepEqual([...route.methods].sort(), ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
})

test('状态接口 GET：给出状态文件路径、生效名单，以及**含被禁技能**的完整目录', async (t) => {
  const h = await createUiHarness()
  t.after(() => h.cleanupAll())

  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')

  const { response, body } = await h.call()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.stateFile, h.stateFile)
  assert.equal(body.status, 'ok')
  assert.equal(body.authoritative, true)
  assert.equal(body.writable, true)
  assert.deepEqual(body.disabled, ['alpha-skill'])
  // 关键：被禁的 alpha-skill 也要在列表里，否则用户没法把它打开。
  assert.deepEqual(body.skills.map((entry) => entry.name).sort(), ['alpha-skill', 'beta-skill'])
  assert.equal(body.skills.find((entry) => entry.name === 'alpha-skill').provider, 'filesystem')
  assert.equal(body.complete, true)
  assert.equal(body.skillsError, null)
  // 对照：同一时刻走正常读取路径（过滤后）的那份目录里没有它。
  assert.equal(has(await h.list(), 'alpha-skill'), false)
})

test('状态接口 POST：按名字读-改-写，回一份新快照；再 POST 打开即恢复', async (t) => {
  const h = await createUiHarness()
  t.after(() => h.cleanupAll())

  const off = await h.toggle('beta-skill', false)
  assert.equal(off.response.status, 200)
  assert.equal(off.body.ok, true)
  assert.deepEqual(off.body.disabled, ['beta-skill'])
  assert.deepEqual(readStateFile(h.stateFile).names, ['beta-skill'], '名单真的落盘了')
  assert.equal(has(await h.list(), 'beta-skill'), false, '宿主过滤同步生效')

  const on = await h.toggle('beta-skill', true)
  assert.equal(on.body.ok, true)
  assert.deepEqual(on.body.disabled, [])
  assert.equal(has(await h.list(), 'beta-skill'), true, '打开后技能回到目录里')
})

test('状态接口 POST：非法技能名 400；损坏的状态文件 409 且文件原样保留', async (t) => {
  const h = await createUiHarness()
  t.after(() => h.cleanupAll())

  const bad = await h.toggle('Foo Bar', false)
  assert.equal(bad.response.status, 400)
  assert.equal(bad.body.ok, false)
  assert.match(bad.body.error, /非法技能名/)

  const broken = '{ "disabled": ["alpha-skill"'
  await writeFile(h.stateFile, broken, 'utf8')
  const refused = await h.toggle('beta-skill', false)
  assert.equal(refused.response.status, 409)
  assert.equal(refused.body.ok, false)
  assert.match(refused.body.error, /状态文件损坏/)
  assert.equal(await readFile(h.stateFile, 'utf8'), broken, '坏文件必须原样保留')

  // 损坏时 GET 仍然可用，但明确告诉页面"只读"。
  const { body } = await h.call()
  assert.equal(body.ok, true)
  assert.equal(body.status, 'corrupt')
  assert.equal(body.authoritative, false)
  assert.equal(body.writable, false)
})

test('状态接口 POST：请求体不合法时 400（不是 500）', async (t) => {
  const h = await createUiHarness()
  t.after(() => h.cleanupAll())

  const notJson = await h.call('/api/skill-toggle/state', { method: 'POST', body: 'nope' })
  assert.equal(notJson.response.status, 400)

  const missing = await h.call('/api/skill-toggle/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alpha-skill' }),
  })
  assert.equal(missing.response.status, 400)
  assert.match(missing.body.error, /enabled/)
})

test('拿不到 connection 服务：只降级（不抛错、不刷日志、不影响宿主过滤）', async (t) => {
  const h = await createHarness() // 没有假 connection
  t.after(() => h.cleanup())

  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')
  assert.equal(has(await h.list(), 'alpha-skill'), false, '过滤机制照旧生效')
  // `ctx.inject` 的姿态是"服务缺席就什么都不做"：非 web 宿主不该每启动一次就刷一行告警。
  assert.equal(
    h.warnings().some((line) => line.includes('状态接口')),
    false,
    'connection 缺席不是错误，不该落告警',
  )
})

test('connection 服务**晚到**也照样注册上（2026-09-28 实测踩过的坑：一次性 ctx.get 会永远读到 undefined）', async (t) => {
  const captured = { route: undefined }
  const h = await createHarness({
    beforeToggle: async ({ root }) => ({
      /** 等插件 apply 之后再 provide —— 复刻宿主里 dsh-client-connection 比本插件晚就绪的顺序。 */
      provideConnection() {
        return root.provide('connection', {
          fetch: {
            register(route) {
              captured.route = route
              return () => { captured.route = undefined }
            },
          },
        })
      },
    }),
  })
  t.after(() => h.cleanup())

  // apply 已经跑完，但 connection 还不存在 ⇒ 这时**不该**有任何注册（也不能抛错）。
  assert.equal(captured.route, undefined, 'apply 那一刻 connection 还没有，注册必须留给 inject 回调')

  h.before.provideConnection()
  await waitUntil(() => captured.route !== undefined, { label: 'connection 一出现，状态接口就该挂上' })
  assert.equal(captured.route.path, '/api/skill-toggle/state')
  assert.deepEqual([...captured.route.methods].sort(), ['GET', 'POST'])
})

test('卸载：状态接口随之摘掉（注册归属落在本插件的 ctx 上）', async (t) => {
  const h = await createUiHarness()
  t.after(() => h.cleanupAll())

  assert.ok(h.captured.route !== undefined)
  await h.toggleFiber.dispose()
  assert.equal(h.captured.route, undefined, '卸载后路由必须摘掉')
  assert.equal(h.captured.disposed, 1)
})

test('readFullCatalog：绕过本插件自己的过滤，拿到的目录含被禁技能', async (t) => {
  const h = await createHarness()
  t.after(() => h.cleanup())

  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')

  const filtered = await h.root.skills.snapshot({})
  assert.equal(has(filtered.skills, 'alpha-skill'), false, '正常读取路径里应当没有它')

  const full = await readFullCatalog(h.root, {})
  assert.deepEqual(full.skills.map((entry) => entry.name).sort(), ['alpha-skill', 'beta-skill'])
  assert.equal(full.complete, true, 'complete 原样透传')

  // 注册表不可用时返回 undefined（页面据此显示"目录读不到"），绝不抛错。
  assert.equal(await readFullCatalog({}, {}), undefined)
  assert.equal(await readFullCatalog(undefined, {}), undefined)
})

test('toggleDisabledName：文件不存在时从备用名单起算，排序去重，非法名拒绝', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')

  // 文件不存在 ⇒ 以备用名单（config.disabled）为起点，不能把里面其它技能悄悄放出来。
  const first = toggleDisabledName(file, ['keep-me'], 'new-one', false)
  assert.equal(first.ok, true)
  assert.deepEqual(first.disabled, ['keep-me', 'new-one'])
  assert.deepEqual(readStateFile(file).names, ['keep-me', 'new-one'])

  // 文件已存在 ⇒ 完全以文件为准（备用名单不再参与）。
  const second = toggleDisabledName(file, ['ignored'], 'another', false)
  assert.deepEqual(second.disabled, ['another', 'keep-me', 'new-one'], '按名字排序')

  const off = toggleDisabledName(file, ['ignored'], 'keep-me', true)
  assert.deepEqual(off.disabled, ['another', 'new-one'])

  const bad = toggleDisabledName(file, [], 'Foo Bar', false)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /非法技能名/)
  assert.deepEqual(readStateFile(file).names, ['another', 'new-one'], '被拒绝时文件一个字都不能动')

  // 损坏 ⇒ 拒绝写入，坏文件原样保留。
  const broken = '{ nope'
  await writeFile(file, broken, 'utf8')
  const corrupt = toggleDisabledName(file, [], 'anything', false)
  assert.equal(corrupt.ok, false)
  assert.match(corrupt.reason, /状态文件损坏/)
  assert.equal(await readFile(file, 'utf8'), broken)
})
