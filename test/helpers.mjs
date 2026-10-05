/**
 * 测试公共件。
 *
 * 两条纪律：
 *  1. 宿主包一律从 **dsh 安装树**解析（`createRequire` 锚到 dsh 的 package.json），
 *     不在插件目录里 `pnpm install`、不建 node_modules；
 *  2. 一切落盘都在**临时目录**里（技能根、状态文件、DSH_HOME），**绝不碰**真实的
 *     `~\.dsh\dsh-skill-toggle.json` 与 `~\.dsh\skills\`。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** dsh 安装树的锚点（默认按 npm 全局安装位置推断，可用 DSH_INSTALL_PACKAGE_JSON 覆盖）。 */
export const DSH_PACKAGE_JSON = process.env.DSH_INSTALL_PACKAGE_JSON
  ?? join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

const anchor = createRequire(DSH_PACKAGE_JSON)

/**
 * 按 dsh 安装树的解析规则加载一个宿主包（返回与 dsh 内部**同一个模块实例**，
 * 这是 `Context` / `Service` 的类身份能对上的前提）。
 * @param {string} specifier 包名。
 */
export async function loadDshModule(specifier) {
  if (!existsSync(DSH_PACKAGE_JSON)) {
    throw new Error(`找不到 dsh 安装锚点 ${DSH_PACKAGE_JSON}（可用 DSH_INSTALL_PACKAGE_JSON 覆盖）`)
  }
  return await import(pathToFileURL(anchor.resolve(specifier)).href)
}

/** 轮询等待：`predicate` 返回真即返回，超时抛错（消息里带 label，便于定位是哪一步没等到）。 */
export async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 25, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await predicate()
    if (last) return last
    if (Date.now() >= deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 造一个临时技能根：每个技能一个 `<名>/SKILL.md` 目录包。 */
export async function makeSkillRoot(skills) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggle-'))
  const skillsRoot = join(dir, 'skills')
  for (const skill of skills) {
    await mkdir(join(skillsRoot, skill.name), { recursive: true })
    await writeFile(
      join(skillsRoot, skill.name, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.name} 的正文。\n`,
      'utf8',
    )
  }
  return { dir, skillsRoot }
}

/** 默认夹具技能（两个，够用来验证"禁一个不影响另一个"）。 */
export const FIXTURE_SKILLS = [
  { name: 'alpha-skill', description: '测试用技能 alpha。' },
  { name: 'beta-skill', description: '测试用技能 beta。' },
]

/**
 * 起一套真家伙：真实 `Context` + 真实 `SkillRegistry` + 真实 `dsh-skill-filesystem`
 * （指向临时技能根）+ 被测插件（状态文件指向临时路径）。
 *
 * @param {{ skills?: {name: string, description: string}[], stateFileContent?: string,
 *   config?: object, filesystem?: boolean, beforeToggle?: (fixture: object) => Promise<any> }} [options]
 *   · `filesystem:false` —— 不在这里装 filesystem provider（调用方自己决定挂哪一层）；
 *   · `beforeToggle`     —— 在装被测插件**之前**跑，用来造作用域链 / 提供 `agents` 桩服务
 *     （必须早于 apply：插件的 agent 视图检查发生在 apply 与 `agent/created` 两处）。
 */
export async function createHarness(options = {}) {
  const { Context } = await loadDshModule('@deepseek-ai/cordis')
  const { default: SkillRegistry } = await loadDshModule('@deepseek-ai/dsh-skill')
  const filesystem = await loadDshModule('@deepseek-ai/dsh-skill-filesystem')
  const toggle = await import('../lib/index.js')

  const { dir, skillsRoot } = await makeSkillRoot(options.skills ?? FIXTURE_SKILLS)
  const stateFile = join(dir, 'dsh-skill-toggle.json')
  if (options.stateFileContent !== undefined) await writeFile(stateFile, options.stateFileContent, 'utf8')

  // 安全网：把 DSH_HOME 也指到临时目录（万一某条路径漏了显式注入，也只会落在临时目录里）。
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const root = new Context()
  const changes = []
  root.on('skills/change', () => changes.push(Date.now()))

  // 宿主默认 exporter 只缓冲（不打印），且默认阈值是 INFO ⇒ warn 会被它自己滤掉。
  // 这里自己挂一个 exporter，把 warn 收下来当断言素材（`levels.default = 3` = DEBUG，全收）。
  const warnings = []
  root.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })

  const registryFiber = await root.plugin(SkillRegistry)
  let fsFiber
  if (options.filesystem !== false) {
    fsFiber = await root.plugin(filesystem, {
      includeDefaultRoots: false,
      customSkillDirs: [skillsRoot],
      watch: false,
    })
  } else {
    fsFiber = { dispose: async () => {} }
  }
  const before = options.beforeToggle === undefined
    ? undefined
    : await options.beforeToggle({ root, dir, skillsRoot, stateFile, filesystem, Context })
  const toggleFiber = await root.plugin(toggle, { stateFile, watchIntervalMs: 30, ...(options.config ?? {}) })

  return {
    root, dir, skillsRoot, stateFile, toggleFiber, fsFiber, registryFiber, toggle, before,
    /** 当前已发生的 `skills/change` 次数（写状态文件前先取一次，用来等"这次变化"）。 */
    changeCount: () => changes.length,
    waitForChange: (marker, timeoutMs = 4000) => waitUntil(() => changes.length > marker, {
      timeoutMs,
      label: '等状态文件变化触发 skills/change（插件监听器里的 invalidate 广播）',
    }),
    /** 读目录并按名字取一条 summary。 */
    async summary(skillName, viewOptions) {
      const skills = await root.skills.list(viewOptions)
      return skills.find((entry) => entry.name === skillName)
    },
    async list(viewOptions) {
      return await root.skills.list(viewOptions)
    },
    /** 插件打过的告警行（宿主默认 exporter 只缓冲不打印 ⇒ 测试里可当断言用）。 */
    warnings: () => [...warnings],
    async cleanup() {
      try { await toggleFiber.dispose() } catch { /* 可能已卸载 */ }
      try { await fsFiber.dispose() } catch { /* 可能已卸载 */ }
      try { await registryFiber.dispose() } catch { /* 可能已卸载 */ }
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(dir, { recursive: true, force: true })
    },
  }
}
