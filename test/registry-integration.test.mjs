/**
 * 集成测试：**真实**技能注册表 + **真实** filesystem provider（指向临时技能根）+ 真实状态文件。
 *
 * 测的是机制本体在宿主形态下到底管不管用：禁用后 `ctx.skills.list()` / `snapshot()` 里**那条技能必须
 * 消失**（不是变成不可调用）、`get()` 必须拿不到；恢复后必须回来；而且是在**同一个 ctx、同一份注册表
 * 缓存**下发生的（证明热生效不是靠"重新起一个进程/上下文"）。
 *
 * v2 起机制是"包一层注册表结果过滤"（v1 的"同名占位候选"已删，实测压不住真身，见 README）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness, waitUntil } from './helpers.mjs'
import { unwrapRegistry } from '../lib/index.js'

/** 目录里有没有这条技能。 */
function has(skills, name) {
  return skills.some((entry) => entry.name === name)
}

/** 断言某条技能由 filesystem provider 提供且可调用（新机制下"没被禁"就是这个样子）。 */
function expectReal(summary, name, note = '') {
  assert.ok(summary !== undefined, `${note}：目录里应当有 ${name}`)
  assert.equal(summary.provider, 'filesystem', `${note}：provider 应当是 filesystem`)
  assert.equal(summary.invocation.modelInvocable, true, `${note}：modelInvocable 应当为真`)
  assert.equal(summary.invocation.userInvocable, true, `${note}：userInvocable 应当为真`)
}

test('未禁用：两条技能都在，由 filesystem provider 提供', async (t) => {
  const h = await createHarness()
  t.after(() => h.cleanup())

  const skills = await h.list()
  assert.deepEqual(skills.map((entry) => entry.name).sort(), ['alpha-skill', 'beta-skill'])
  expectReal(skills.find((entry) => entry.name === 'alpha-skill'), 'alpha-skill')
  expectReal(skills.find((entry) => entry.name === 'beta-skill'), 'beta-skill')
})

test('核心用例：写进状态文件后同一 ctx 的 list()/snapshot() 里那条技能消失，删掉后恢复', async (t) => {
  const h = await createHarness()
  t.after(() => h.cleanup())

  // ① 先读一次，让注册表的合并缓存**落定**（证明生效不是靠"新缓存键"，而是靠读取结果过滤）
  expectReal(await h.summary('alpha-skill'), 'alpha-skill', '禁用前')

  // ② 禁用 alpha-skill
  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] }, null, 2)}\n`, 'utf8')
  await waitUntil(async () => !has(await h.list(), 'alpha-skill'), { label: '禁用后 alpha-skill 从目录里消失' })

  assert.equal(await h.summary('alpha-skill'), undefined, 'list() 里不许再有被禁技能')
  const snapshot = await h.root.skills.snapshot({})
  assert.equal(has(snapshot.skills, 'alpha-skill'), false, 'snapshot() 里也不许有')
  assert.equal(snapshot.complete, true, 'complete 必须原样保留')
  // 没被禁的技能不许被牵连
  expectReal(await h.summary('beta-skill'), 'beta-skill', '禁用 alpha 后的 beta')
  expectReal(snapshot.skills.find((entry) => entry.name === 'beta-skill'), 'beta-skill', '禁用 alpha 后的 beta（快照里）')

  // ③ 恢复 alpha-skill
  await writeFile(h.stateFile, `${JSON.stringify({ disabled: [] }, null, 2)}\n`, 'utf8')
  await waitUntil(async () => has(await h.list(), 'alpha-skill'), { label: '恢复后 alpha-skill 回到目录' })
  expectReal(await h.summary('alpha-skill'), 'alpha-skill', '恢复后')
})

test('get()：被禁技能返回 undefined（skill 工具与 /名字 手势都拿不到），未禁技能照旧拿到真身', async (t) => {
  const h = await createHarness({ stateFileContent: `${JSON.stringify({ disabled: ['alpha-skill'] })}\n` })
  t.after(() => h.cleanup())

  assert.equal(await h.root.skills.get('alpha-skill'), undefined, '被禁技能不该能被加载')
  const enabled = await h.root.skills.get('beta-skill')
  assert.equal(enabled.provider, 'filesystem')
  assert.match(enabled.content, /beta-skill 的正文/)
})

test('ctx.skills 是 Cordis 的 traceable Proxy：包装落在原实例上，通过 Proxy 读取照样被过滤', async (t) => {
  const h = await createHarness({ stateFileContent: `${JSON.stringify({ disabled: ['alpha-skill'] })}\n` })
  t.after(() => h.cleanup())

  const proxy = h.root.skills
  const raw = unwrapRegistry(proxy)
  assert.notEqual(raw, proxy, 'ctx.skills 拿到的是 Cordis 包的 Proxy，不是裸实例')
  assert.equal(raw.constructor.name, 'SkillRegistry')
  assert.equal(Object.hasOwn(raw, 'snapshot'), true, '包装必须是原实例上的自有属性（否则等于没包）')
  assert.equal(typeof raw.snapshot, 'function')
  assert.equal(typeof Object.getPrototypeOf(raw).snapshot, 'function', '原型上的原方法必须原封不动（还原时要回落到它）')

  // 通过 Proxy 走一遍（模型/工具路径的真实形态）
  assert.deepEqual((await proxy.list()).map((entry) => entry.name), ['beta-skill'])
  assert.equal(has((await proxy.snapshot({})).skills, 'alpha-skill'), false)
  assert.equal(await proxy.get('alpha-skill'), undefined)
})

test('状态文件损坏：按"全部启用"处理、不抛错、且绝不覆盖坏文件（一行警告）', async (t) => {
  const broken = '{ "disabled": [ "alpha-skill"  '
  const h = await createHarness({ stateFileContent: broken })
  t.after(() => h.cleanup())

  for (let round = 0; round < 3; round += 1) {
    const skills = await h.list() // 不许抛
    expectReal(skills.find((entry) => entry.name === 'alpha-skill'), 'alpha-skill', `第 ${round + 1} 次读`)
  }
  assert.equal(await readFile(h.stateFile, 'utf8'), broken, '坏文件必须原样保留（否则用户的名单会被清空）')
  const corruptWarnings = h.warnings().filter((line) => line.includes('状态文件不可用'))
  assert.equal(corruptWarnings.length, 1, `同一处损坏只该打一行警告，实际 ${corruptWarnings.length} 行`)
})

test('非法技能名被忽略（进 dropped 告警），同一份名单里的合法名字照常生效', async (t) => {
  const h = await createHarness({
    stateFileContent: `${JSON.stringify({ disabled: ['alpha-skill', 'Foo Bar', 42, 'beta_skill'] }, null, 2)}\n`,
  })
  t.after(() => h.cleanup())

  const skills = await h.list()
  assert.equal(has(skills, 'alpha-skill'), false, '合法名字照常被摘掉')
  expectReal(skills.find((entry) => entry.name === 'beta-skill'), 'beta-skill', '未列入的技能')
  assert.equal(has(skills, 'Foo Bar'), false)
  assert.ok(h.warnings().some((line) => line.includes('不是合法技能名')), '应当有一行"已忽略非法条目"的警告')
})

test('名单里的陌生名字：没有对应的真身可摘，不影响任何真实技能，也不报错', async (t) => {
  const h = await createHarness({ stateFileContent: `${JSON.stringify({ disabled: ['ghost-skill'] })}\n` })
  t.after(() => h.cleanup())

  const skills = await h.list()
  assert.deepEqual(skills.map((entry) => entry.name).sort(), ['alpha-skill', 'beta-skill'])
  expectReal(skills.find((entry) => entry.name === 'alpha-skill'), 'alpha-skill', 'alpha 不受影响')
  assert.equal(await h.root.skills.get('ghost-skill'), undefined)
})

test('插件卸载：原方法被还原（自有属性消失），技能立刻回来，技能文件毫发无损', async (t) => {
  const h = await createHarness({ stateFileContent: `${JSON.stringify({ disabled: ['alpha-skill'] })}\n` })
  t.after(() => h.cleanup())

  const raw = unwrapRegistry(h.root.skills)
  assert.equal(has(await h.list(), 'alpha-skill'), false, '卸载前：被禁技能不可见')

  await h.toggleFiber.dispose()
  await waitUntil(async () => has(await h.list(), 'alpha-skill'), { label: '卸载后 alpha-skill 回到目录' })

  assert.equal(Object.hasOwn(raw, 'snapshot'), false, '卸载必须把自有属性删掉')
  assert.equal(raw.snapshot, Object.getPrototypeOf(raw).snapshot, 'snapshot 必须回落到原型上的原方法')
  assert.equal(Object.hasOwn(raw, 'list'), false)
  assert.equal(Object.hasOwn(raw, 'get'), false)
  expectReal(await h.summary('alpha-skill'), 'alpha-skill', '卸载后')
  assert.match(await readFile(join(h.skillsRoot, 'alpha-skill', 'SKILL.md'), 'utf8'), /name: alpha-skill/, '技能文件不该被动过')
})

test('幂等：apply 两次不叠层；两个都卸载之后才还原', async (t) => {
  const h = await createHarness({ stateFileContent: `${JSON.stringify({ disabled: ['alpha-skill'] })}\n` })
  t.after(() => h.cleanup())

  const raw = unwrapRegistry(h.root.skills)
  const firstWrapper = raw.snapshot
  const second = await h.root.plugin(h.toggle, { stateFile: h.stateFile, watchIntervalMs: 30 })

  assert.equal(raw.snapshot, firstWrapper, '第二次 apply 不许叠第二层包装')
  assert.equal(has(await h.list(), 'alpha-skill'), false, '过滤照常生效')

  await h.toggleFiber.dispose() // 第一个包装者走了，第二个还在
  assert.equal(Object.hasOwn(raw, 'snapshot'), true, '还有包装者活着 ⇒ 不许还原')
  assert.equal(has(await h.list(), 'alpha-skill'), false, '过滤仍在')

  await second.dispose()
  assert.equal(Object.hasOwn(raw, 'snapshot'), false, '所有包装者都走了 ⇒ 还原')
  assert.equal(has(await h.list(), 'alpha-skill'), true)
})

test('config.disabled 只是备用注入点：状态文件一旦存在就以文件为准', async (t) => {
  // 文件不存在 ⇒ config.disabled 生效
  const noFile = await createHarness({ config: { disabled: ['alpha-skill'] } })
  t.after(() => noFile.cleanup())
  assert.equal(has(await noFile.list(), 'alpha-skill'), false, '文件不存在时用 config')

  // 文件存在（哪怕是空名单）⇒ 完全以文件为准，config 里的名字不再生效
  const withFile = await createHarness({
    stateFileContent: `${JSON.stringify({ disabled: [] })}\n`,
    config: { disabled: ['alpha-skill'] },
  })
  t.after(() => withFile.cleanup())
  expectReal(await withFile.summary('alpha-skill'), 'alpha-skill', '文件存在时以文件为准')
})

test('真实注册表 + 真实 provider：一次瞬时的不完整观测被兜底重读救回（当步就 complete=true）', async (t) => {
  // 现场：`dsh-skill` 的 collect() 在采集期间 revision 变了两次（MAX_COLLECT_ATTEMPTS=2）就返回
  // cacheable=false —— 此时候选是**全的**、也没有任何告警，但 `dsh-tool-skill` 会因为
  // `if (!snapshot.complete) return decision` 整步不下发目录。这里用一个"第一次报不完整、
  // 之后报完整"的 provider 复刻那个瞬时形态，证明包装后的 snapshot 当步就能拿到完整结果。
  let calls = 0
  const flaky = {
    name: 'flaky-probe',
    list: () => {
      calls += 1
      return calls === 1 ? { candidates: [], complete: false } : { candidates: [], complete: true }
    },
    get: async () => undefined,
  }
  const h = await createHarness({
    stateFileContent: `${JSON.stringify({ disabled: [] })}\n`,
    beforeToggle: async ({ root }) => {
      root.skills.registerProvider(() => flaky)
    },
  })
  t.after(() => h.cleanup())

  const snapshot = await h.root.skills.snapshot({})
  assert.equal(snapshot.complete, true, '兜底重读必须把这一次瞬时的不完整救回来')
  assert.ok(calls >= 2, `重读必须真的发生（实际调用 ${calls} 次）`)
  expectReal(snapshot.skills.find((entry) => entry.name === 'alpha-skill'), 'alpha-skill', '重读不影响真身')
})

test('snapshot().complete 原样保留：过滤条目不改变完整度（不完整也照样滤）', async (t) => {
  // 造一个"发现不完整"的 provider（`complete:false`）：宿主里 `dsh-skill-filesystem` 在
  // watchManager.observeRoots() 抛错时就是这个形态（实测会导致整场会话不发技能目录）。
  const incomplete = {
    name: 'incomplete-probe',
    list: () => ({ candidates: [], complete: false }),
    get: async () => undefined,
  }
  const h = await createHarness({
    stateFileContent: `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`,
    beforeToggle: async ({ root }) => {
      root.skills.registerProvider(() => incomplete)
    },
  })
  t.after(() => h.cleanup())

  const snapshot = await h.root.skills.snapshot({})
  assert.equal(snapshot.complete, false, 'complete=false 必须原样透出（不许被过滤逻辑改成 true）')
  assert.equal(has(snapshot.skills, 'alpha-skill'), false, '不完整也要照样滤掉被禁技能')
  expectReal(snapshot.skills.find((entry) => entry.name === 'beta-skill'), 'beta-skill', '未禁技能照旧')
})
