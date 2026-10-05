/**
 * 分层测试：证明新机制**与作用域层无关**（这正是换机制的原因）。
 *
 * 用真实的 `@deepseek-ai/dsh-scope`（`createScope`）造出与宿主同构的作用域链：
 *   root（全局层）→ presetScope（预设层，官方 filesystem provider 挂在这里）
 *                 → agentScope（agent 层）
 * 读的时候 `layers = [global, ...chainLayers(scope)]`，`chainLayers` 是"远祖先在前、本层在最后"
 * ⇒ 近层同名**直接盖掉**远层，与 rank 无关（rank 只在同一层内分胜负）。
 * v1 的"同名占位候选"必须和真身**同层**才赢得下来，本机实测恰恰输在这里（2026-09-28 探针：
 * 占位 rank=-1e9 却输给了同层的 filesystem rank=400）。v2 包的是注册表实例的**读取结果**，
 * 不参与任何层合并 ⇒ 真身挂在哪一层都照样摘掉 —— 下面三条用例钉住这个性质。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHarness, loadDshModule, waitUntil } from './helpers.mjs'
import { unwrapRegistry } from '../lib/index.js'

/** 目录里有没有这条技能。 */
function has(skills, name) {
  return skills.some((entry) => entry.name === name)
}

/**
 * 造一套"预设层 + agent 层"的骨架：filesystem provider 挂在 preset 层（与宿主 web profile
 * 的真实形态一致），agent 对象本身就是 agent 层的 scope key（宿主读目录时就是传 `scope: agent`）。
 *
 * @param {{ withAgents?: boolean }} [options] `withAgents:false` ⇒ 不提供 `agents` 服务，
 *   用来证明核心机制**不需要**它（v1 要靠它按 agent 补注册，v2 不需要）。
 */
async function createScopedHarness(options = {}) {
  const withAgents = options.withAgents !== false
  const { createScope } = await loadDshModule('@deepseek-ai/dsh-scope')
  const filesystem = await loadDshModule('@deepseek-ai/dsh-skill-filesystem')

  const base = await createHarness({
    filesystem: false,
    beforeToggle: async ({ root, skillsRoot }) => {
      const presetKey = { preset: 'demo-preset' }
      const preset = createScope(root, presetKey)
      const presetFsFiber = await preset.ctx.plugin(filesystem, {
        includeDefaultRoots: false,
        customSkillDirs: [skillsRoot],
        watch: false,
      })
      const agent = { id: 'agent-1' }
      const agentScope = createScope(root, agent, { parent: presetKey })
      agent.ctx = agentScope.ctx
      const provideDispose = withAgents ? root.provide('agents', { list: () => [agent] }) : () => {}
      return { presetKey, preset, presetFsFiber, agent, agentScope, provideDispose }
    },
  })

  return {
    ...base,
    ...base.before,
    async cleanupScoped() {
      try { await base.toggleFiber.dispose() } catch { /* 已卸载 */ }
      try { await base.before.agentScope.dispose() } catch { /* 已卸载 */ }
      try { await base.before.presetFsFiber.dispose() } catch { /* 已卸载 */ }
      try { await base.before.preset.dispose() } catch { /* 已卸载 */ }
      base.before.provideDispose()
      await base.cleanup()
    },
  }
}

test('真身在 preset 层（比全局层更近）：照样被摘掉，恢复后回来', async (t) => {
  const h = await createScopedHarness()
  t.after(() => h.cleanupScoped())

  // 禁用前：agent 视角看到的是 preset 层的真身（近层胜）
  const before = await h.list({ scope: h.agent })
  assert.equal(before.find((entry) => entry.name === 'alpha-skill')?.provider, 'filesystem', '禁用前应当是 filesystem')
  assert.equal(before.find((entry) => entry.name === 'alpha-skill')?.invocation.modelInvocable, true)

  // 禁用：写名单即可，**不需要**在 agent 层注册任何东西
  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')
  await waitUntil(async () => !has(await h.list({ scope: h.agent }), 'alpha-skill'), {
    label: 'agent 视角里 alpha-skill 消失（真身在 preset 层也照样摘）',
  })

  const scoped = await h.list({ scope: h.agent })
  assert.equal(has(scoped, 'alpha-skill'), false, '被禁技能必须整条消失（不是变成不可调用）')
  assert.equal(await h.root.skills.get('alpha-skill', { scope: h.agent }), undefined, 'get() 也拿不到')
  assert.equal(has(await h.list(), 'alpha-skill'), false, '全局视角同样没有')
  assert.ok(has(scoped, 'beta-skill'), '未被禁的 preset 技能照旧在')

  // 恢复：真身回来（近层那份从没被动过）
  await writeFile(h.stateFile, `${JSON.stringify({ disabled: [] })}\n`, 'utf8')
  await waitUntil(async () => has(await h.list({ scope: h.agent }), 'alpha-skill'), { label: '恢复后真身回归' })
  assert.equal((await h.summary('alpha-skill', { scope: h.agent }))?.provider, 'filesystem')
})

test('拿不到 agents 服务也照样摘（核心机制不依赖 agents / 不依赖作用域层）', async (t) => {
  const h = await createScopedHarness({ withAgents: false })
  t.after(() => h.cleanupScoped())

  // 先确认骨架成立：agent 视角能看到 preset 层的真身（此时插件已 apply，但名单是空的）
  assert.equal((await h.summary('alpha-skill', { scope: h.agent }))?.provider, 'filesystem')

  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')
  await waitUntil(async () => !has(await h.list({ scope: h.agent }), 'alpha-skill'), {
    label: '没有 agents 服务时也摘得掉',
  })
  assert.equal(await h.root.skills.get('alpha-skill', { scope: h.agent }), undefined)
})

test('卸载：原方法被还原，agent 视角里 preset 的真身回归', async (t) => {
  const h = await createScopedHarness()
  t.after(() => h.cleanupScoped())

  await writeFile(h.stateFile, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')
  await waitUntil(async () => !has(await h.list({ scope: h.agent }), 'alpha-skill'), { label: '禁用生效' })

  const raw = unwrapRegistry(h.root.skills)
  assert.equal(Object.hasOwn(raw, 'snapshot'), true, '包装是原实例上的自有属性')

  await h.toggleFiber.dispose()
  await waitUntil(async () => has(await h.list({ scope: h.agent }), 'alpha-skill'), { label: '卸载后真身回归' })
  assert.equal(Object.hasOwn(raw, 'snapshot'), false, '卸载必须还原')
  assert.equal((await h.summary('alpha-skill', { scope: h.agent }))?.invocation.modelInvocable, true)
  assert.match(await readFile(join(h.skillsRoot, 'alpha-skill', 'SKILL.md'), 'utf8'), /name: alpha-skill/, '技能文件不该被动过')
})
