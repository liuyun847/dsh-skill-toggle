/**
 * 单元测试：**注册表包装**（机制本体）。
 *
 * 用**假 registry**（普通对象，`snapshot` / `list` / `get` 都是自有属性）测，不依赖真实宿主：
 * 覆盖过滤规则、`complete` 保留、每次现读名单、幂等与还原、以及"包在哪个对象上"。
 * 真实注册表 + 真实 filesystem provider 的行为见 `registry-integration.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStateFile, unwrapRegistry, wrapSkillRegistry } from '../lib/index.js'

/** 造一个临时目录（用完删）。 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggle-wrap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 夹具条目（与真实注册表返回的 summary 同形）。 */
const ENTRIES = [
  { name: 'alpha-skill', description: '测试用技能 alpha。', invocation: { modelInvocable: true, userInvocable: true }, source: 'filesystem', provider: 'filesystem' },
  { name: 'beta-skill', description: '测试用技能 beta。', invocation: { modelInvocable: true, userInvocable: true }, source: 'filesystem', provider: 'filesystem' },
]

/**
 * 假注册表：三个方法都是**自有属性**，返回同一批条目对象（数组是新的、条目是同一引用，
 * 便于断言"没被无谓复制"）。`calls` 记录原方法被调了几次 —— 用来证明包装是"包一层"
 * 而不是"整段替换"，也用来数幂等（叠两层的话原方法会被调两次）。
 */
function makeFakeRegistry(entries = ENTRIES) {
  const calls = { snapshot: 0, list: 0, get: 0 }
  const registry = {
    async snapshot() {
      calls.snapshot += 1
      return { skills: [...entries], complete: true }
    },
    async list() {
      calls.list += 1
      return [...entries]
    },
    async get(name) {
      calls.get += 1
      return entries.find((entry) => entry.name === name)
    },
  }
  return { registry, calls }
}

/** 与插件里 `currentDisabled()` 同构的名单来源：**每次调用现读状态文件**。 */
function stateReader(stateFile) {
  return () => new Set(readStateFile(stateFile).names)
}

/** 写一份状态文件。 */
async function writeState(stateFile, names) {
  await writeFile(stateFile, `${JSON.stringify({ disabled: names })}\n`, 'utf8')
}

test('snapshot()：被禁技能从结果里消失、未禁的照旧，complete 等其它字段原样保留', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry, calls } = makeFakeRegistry()
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))
  t.after(() => handle.release())
  assert.equal(handle.ok, true)
  assert.equal(handle.already, false)
  assert.deepEqual(handle.wrappedMethods, ['snapshot', 'list', 'get'])

  const snapshot = await registry.snapshot({})
  assert.deepEqual(snapshot.skills.map((entry) => entry.name), ['beta-skill'], '被禁的 alpha 必须消失')
  assert.equal(snapshot.complete, true, 'complete 必须原样保留（过滤不参与完整度判定）')
  assert.equal(snapshot.skills[0], ENTRIES[1], '未被禁的条目身份不变（不做无谓复制）')
  assert.equal(calls.snapshot, 1, '原 snapshot 必须被调用一次（包装，不是替换）')
})

test('list()：同样过滤（即使原实现不经过 snapshot，也要自己滤一遍）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['beta-skill'])

  const { registry, calls } = makeFakeRegistry()
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))
  t.after(() => handle.release())

  assert.deepEqual((await registry.list({})).map((entry) => entry.name), ['alpha-skill'])
  assert.equal(calls.list, 1)
  assert.equal(calls.snapshot, 0, '假 list 不经过 snapshot ⇒ 证明 list 的过滤是独立的')
})

test('get()：被禁技能返回 undefined；未禁技能原样返回（同一个对象）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry } = makeFakeRegistry()
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))
  t.after(() => handle.release())

  assert.equal(await registry.get('alpha-skill'), undefined, '被禁技能不该能被加载')
  assert.equal(await registry.get('beta-skill'), ENTRIES[1])
  assert.equal(await registry.get('ghost-skill'), undefined, '本来就不存在的名字照旧 undefined')
})

test('名单每次现读状态文件：同一进程内改文件，下一次读取立刻反映新名单', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry } = makeFakeRegistry()
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))
  t.after(() => handle.release())

  assert.deepEqual((await registry.list({})).map((entry) => entry.name), ['beta-skill'])

  // 换名单：没有 watch、没有 invalidate、没有缓存 —— 下一次读取就该是新名单
  await writeState(stateFile, ['beta-skill'])
  assert.deepEqual((await registry.list({})).map((entry) => entry.name), ['alpha-skill'])
  assert.equal(await registry.get('beta-skill'), undefined)

  // 清空名单：两个都回来
  await writeState(stateFile, [])
  assert.deepEqual((await registry.list({})).map((entry) => entry.name), ['alpha-skill', 'beta-skill'])
  assert.equal((await registry.snapshot({})).skills.length, 2)
})

test('状态文件损坏：按"全部启用"处理（fail-open），且绝不覆盖坏文件', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  const broken = '{ "disabled": [ "alpha-skill"  '
  await writeFile(stateFile, broken, 'utf8')

  const { registry } = makeFakeRegistry()
  // 插件里损坏的判定在 currentDisabled() 里（三态），这里用同一个 readStateFile 复现那条规则：
  // corrupt ⇒ 空名单（全部启用）。**绝不写文件**。
  const reader = () => {
    const state = readStateFile(stateFile)
    return new Set(state.status === 'corrupt' ? [] : state.names)
  }
  const handle = wrapSkillRegistry(registry, reader)
  t.after(() => handle.release())

  for (let round = 0; round < 3; round += 1) {
    assert.equal((await registry.list({})).length, 2, `第 ${round + 1} 次读：坏文件 ⇒ 全部可见`)
  }
  assert.equal(await readFile(stateFile, 'utf8'), broken, '坏文件必须原样保留（否则用户的名单会被清空）')
})

test('卸载：三个方法都还原成包装前的函数（自有属性写回）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry } = makeFakeRegistry()
  const original = { snapshot: registry.snapshot, list: registry.list, get: registry.get }
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))

  assert.notEqual(registry.snapshot, original.snapshot, '包装后必须是另一个函数')
  assert.equal((await registry.list({})).length, 1)

  handle.release()
  assert.equal(registry.snapshot, original.snapshot, 'snapshot 必须还原成原函数')
  assert.equal(registry.list, original.list, 'list 必须还原成原函数')
  assert.equal(registry.get, original.get, 'get 必须还原成原函数')
  assert.equal((await registry.list({})).length, 2, '还原后不再过滤')
  handle.release() // 幂等：再释放一次不许抛、也不许把别人的包装拆了
  assert.equal(registry.list, original.list)
})

test('幂等 + 引用计数：同一实例包两次只装一层，两个包装者都释放后才还原', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry, calls } = makeFakeRegistry()
  const original = registry.snapshot
  const first = wrapSkillRegistry(registry, stateReader(stateFile))
  const afterFirst = registry.snapshot
  const second = wrapSkillRegistry(registry, stateReader(stateFile))

  assert.equal(first.already, false)
  assert.equal(second.already, true, '第二次包装必须认出"已经包过了"')
  assert.equal(registry.snapshot, afterFirst, '第二次包装不许叠第二层')
  assert.equal((await registry.snapshot({})).skills.length, 1, '过滤照常生效')
  assert.equal(calls.snapshot, 1, '只叠一层的话原方法每次只被调一次')

  first.release()
  assert.equal(registry.snapshot, afterFirst, '还有包装者活着 ⇒ 不许还原')
  assert.equal((await registry.list({})).length, 1, '过滤仍在')

  second.release()
  assert.equal(registry.snapshot, original, '所有包装者都走了 ⇒ 还原')
  assert.equal((await registry.list({})).length, 2)

  // 还原之后可以重新包装（WRAP_STATE 已删掉，不是"一次性"的）
  const third = wrapSkillRegistry(registry, stateReader(stateFile))
  assert.equal(third.already, false, '还原后重新包装必须重新装一层')
  assert.equal((await registry.list({})).length, 1)
  third.release()
})

test('只包读取路径：写路径（registerProvider / register）与其它属性一个字都不动', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry } = makeFakeRegistry()
  const registerProvider = () => 'registered'
  const register = () => 'registered'
  registry.registerProvider = registerProvider
  registry.register = register
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))
  t.after(() => handle.release())

  assert.equal(registry.registerProvider, registerProvider, '写路径不许被动')
  assert.equal(registry.register, register)
  assert.equal(registry.registerProvider(), 'registered')
})

test('名单为空时原样返回（不复制数组、不碰对象身份）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, [])

  const { registry } = makeFakeRegistry()
  const handle = wrapSkillRegistry(registry, stateReader(stateFile))
  t.after(() => handle.release())

  const snapshot = await registry.snapshot({})
  assert.equal(snapshot.skills.length, 2)
  const list = await registry.list({})
  assert.equal(list.length, 2)
})

test('wrapSkillRegistry 对不可用的注册表只报错不抛（apply 绝不把异常抛回 loader）', async () => {
  for (const value of [undefined, null, 42, 'skills', {}]) {
    const handle = wrapSkillRegistry(value, () => new Set())
    if (value !== null && typeof value === 'object') {
      // `{}` 这种"什么都没有"的对象：装不上任何方法，但也不许抛
      assert.equal(handle.ok, true, '空对象也要能包（三个方法都缺失 ⇒ 什么都不装）')
      assert.deepEqual(handle.wrappedMethods, [])
    } else {
      assert.equal(handle.ok, false, `${String(value)} 不是对象 ⇒ ok:false`)
      assert.equal(typeof handle.reason, 'string')
    }
    handle.release()
  }
})

test('complete=false 时重读一次：第二次为真则采用（瞬时竞态不再吞掉整场技能目录）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  let calls = 0
  const registry = {
    async snapshot() {
      calls += 1
      return { skills: [...ENTRIES], complete: calls > 1 }
    },
    async list() { return [...ENTRIES] },
    async get() { return undefined },
  }
  // diagnose:false ⇒ 本用例只测兜底重读，静音诊断日志（诊断另有专门用例）
  const handle = wrapSkillRegistry(registry, stateReader(stateFile), { diagnose: false })
  t.after(() => handle.release())

  const snapshot = await registry.snapshot({})
  assert.equal(snapshot.complete, true, '重读明确为真 ⇒ 采用重读结果（当步就能下发目录）')
  assert.equal(calls, 2, '重读有界：只多读一次')
  assert.deepEqual(snapshot.skills.map((entry) => entry.name), ['beta-skill'], '过滤照旧作用在最终结果上')
})

test('provider 持续不完整：两次都是假 ⇒ 结果照旧为假（**绝不伪造 complete**）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  let calls = 0
  const registry = {
    async snapshot() {
      calls += 1
      return { skills: [...ENTRIES], complete: false }
    },
    async list() { return [...ENTRIES] },
    async get() { return undefined },
  }
  const handle = wrapSkillRegistry(registry, stateReader(stateFile), { diagnose: false })
  t.after(() => handle.release())

  const snapshot = await registry.snapshot({})
  assert.equal(snapshot.complete, false, '持续不完整必须原样透出（否则真问题被掩盖）')
  assert.equal(calls, 2, '重读有界：只多读一次')
  assert.deepEqual(snapshot.skills.map((entry) => entry.name), ['beta-skill'])
})

test('观测点：complete=false 时把逐 provider 成因、watcher 根状态与抛错原文写进 stdout', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, [])

  const rootPath = 'C:\\tmp\\skills'
  const provider = {
    name: 'filesystem',
    list: () => ({ candidates: [], complete: false }),
    get: async () => undefined,
    watchManager: {
      config: { enabled: true },
      projects: new Map(),
      roots: new Map([[rootPath, { unhealthy: true, watcher: undefined, owners: new Set(['shared:C:\\tmp\\skills']) }]]),
      closing: false,
      async ensureWatcher() {
        throw new Error(`EPERM: operation not permitted, watch '${rootPath}'`)
      },
    },
  }
  const registry = {
    revision: 7,
    layers: {
      global: { providers: { entries: () => [['filesystem', { provider }]] } },
      chainLayers: () => [],
    },
    async snapshot() { return { skills: [], complete: false } },
    async list() { return [] },
    async get() { return undefined },
  }

  const lines = []
  const originalWarn = console.warn
  console.warn = (line) => lines.push(String(line))
  let handle
  try {
    handle = wrapSkillRegistry(registry, stateReader(stateFile))
    await registry.snapshot({ cwd: 'C:\\tmp' })
  } finally {
    console.warn = originalWarn
    handle?.release()
  }

  const text = lines.join('\n')
  assert.match(text, /\[skill-toggle\]\[INCOMPLETE\]/, '必须落盘一行 INCOMPLETE 诊断')
  assert.match(text, /revision=7/, '要带注册表 revision（用于识别竞态）')
  assert.match(text, /provider=filesystem/, '要指名是哪个 provider')
  assert.match(text, new RegExp(rootPath.replaceAll('\\', '\\\\')), '要指名出错/不健康的根路径')
  assert.match(text, /EPERM/, '要带抛错原文')
})

test('观测点对陌生的注册表结构只少几行、不抛错（假 registry 没有 layers/revision）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, [])

  const registry = {
    async snapshot() { return { skills: [], complete: false } },
    async list() { return [] },
    async get() { return undefined },
  }
  const lines = []
  const originalWarn = console.warn
  console.warn = (line) => lines.push(String(line))
  let handle
  try {
    handle = wrapSkillRegistry(registry, stateReader(stateFile))
    const snapshot = await registry.snapshot({})
    assert.equal(snapshot.complete, false, '诊断不出内容也不许改变结果')
  } finally {
    console.warn = originalWarn
    handle?.release()
  }
  assert.match(lines.join('\n'), /拿不到 provider 列表/)
})

test('unwrapRegistry：不是 Proxy 的对象原样返回（假 registry 与真实实例都适用）', async (t) => {
  const dir = await tempDir(t)
  const stateFile = join(dir, 'state.json')
  await writeState(stateFile, ['alpha-skill'])

  const { registry } = makeFakeRegistry()
  assert.equal(unwrapRegistry(registry), registry, '普通对象原样返回')
  assert.equal(unwrapRegistry(undefined), undefined)
  assert.equal(unwrapRegistry(null), null)

  // 带 Cordis 那个符号的对象：返回符号指向的原对象（真实 ctx.skills 就是这种 Proxy）
  const original = { marker: true }
  const proxy = { [Symbol.for('cordis.original')]: original }
  assert.equal(unwrapRegistry(proxy), original, '必须取回被包的原对象')
  const handle = wrapSkillRegistry(proxy, stateReader(stateFile))
  t.after(() => handle.release())
  assert.equal(handle.instance, original, '包装必须落在原对象上，不是 Proxy 上')
})
