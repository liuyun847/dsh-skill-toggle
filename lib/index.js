/**
 * dsh-skill-toggle v0.3.0（机制 v2 + 不完整快照的落盘诊断与有界兜底重读 + 设置页 UI）
 * —— DSH 宿主插件：按一份"禁用名单"把指定技能从模型可见目录里摘掉。
 *
 * 一句话：名单里的技能名，会被**从技能注册表的读取结果里滤掉** —— 模型目录（注入的
 * `<available_skills>` 块）、`skill` 工具、用户 `/名字` 手势三处一起摘；把名字从名单里删掉即恢复。
 * **本插件不改任何技能文件**（连技能目录都不读，只认名字），也**不改 `dsh-skill` 包的任何文件**。
 *
 * ── v0.3.0：设置页 UI（本文件提供它的宿主侧）────────────────────────────────
 * 客户端半身（`lib/client.js`）在「设置 → 技能开关」里给每个技能一个开关，读写的是**同一份状态文件**。
 * 本文件为此提供一条只读/只改名单的精确 Fetch 路由 {@link STATE_ROUTE}（挂在共享 `/api` 通道，
 * 因此经过浏览器信任栅栏与会话鉴权），它做两件现有机制里没有的事：
 *   · {@link readFullCatalog} —— 取**含被禁技能**的完整目录（走包装记账里的原方法，绕过自己的过滤）；
 *   · {@link toggleDisabledName} —— 读-改-写一个名字（与 CLI 共用，损坏时一律拒绝写）。
 * 路由与过滤机制完全解耦：拿不到 `connection` 时只降级，宿主过滤一个字都不受影响。
 *
 * ── 机制 v2：包一层技能注册表实例（本文件的核心）────────────────────────────
 * 在 `ctx.skills`（`@deepseek-ai/dsh-skill` 的 `SkillRegistry` 实例）上装三个**自有方法**，
 * 先调原方法、再过滤结果：
 *   · `snapshot(options)` —— 滤掉 `skills` 数组里名字在名单里的条目；`complete` 等其它字段原样保留；
 *   · `list(options)`     —— 同理（宿主实现就是 `(await this.snapshot(options)).skills`；两条都包是保险，
 *                            过滤本身幂等 ⇒ 内部那次先滤一遍不会出问题）；
 *   · `get(name, options)`—— 名字在名单里**直接返回 `undefined`**（被禁技能不该能被加载）。
 * 名单**每次调用现读状态文件**（`currentDisabled()`，与 `fs.watchFile` 轮询配套）⇒ 不缓存、不滞后。
 *
 * ── 为什么换掉 v1 的"注册同名占位候选" ────────────────────────────────────
 * v1 注册一个同名占位 provider（`invocation.modelInvocable=false`、rank `-1e9`），指望
 * "注册表逐层合并时近层同名盖远层"压住真身。2026-09-28 凌晨 8 次宿主重启 + 探针实测（证据在
 * `<工具目录>\dsh-watchdog-dsh.log`，探针行前缀 `[skill-toggle]`、编号 PROBE-1…7）：
 *   · 占位 provider 确实注册成功、每次 collect 也确实被调用（`provider.list()` 有日志）；
 *   · 但它**输在同一层内的去重**上：探针 PROBE-6 打出的 `层4 providers=[skill-toggle,filesystem]`
 *     里 `readme-generator` 胜出的是 `filesystem(rank=400, modelInvocable=true)`，而占位 rank=-1e9
 *     本该更小（`dsh-skill` 的 `collectLayer` 按 rank 升序后按名字去重）；
 *   · 自检（探针 PROBE-4）也证明没摘掉：`complete=false 共10项 含readme-generator=true 该项provider=filesystem`。
 * 具体原因未定（不再深挖）。结论：**不能依赖合并/去重规则** —— 包装读取结果不参与任何层合并，
 * 宿主内部怎么合并都拦得住。
 *
 * ── `complete === false` 为什么会让整场会话看不到技能目录（2026-09-28 追加）─────────
 * `dsh-tool-skill` 的 `agent/pre-step` 是**唯一**下发技能目录的地方，它的第一道门就是
 * `if (!snapshot.complete) return decision;`（`dsh-tool-skill/lib/index.js:216`）⇒
 * 只要 `complete` 为假，**这一步不下发、也不重发**；若每个模型步骤都为假，整场会话都没有目录。
 * 而 `complete` 来自 `SkillRegistry.collect()` 的 `cacheable`，被置假只有三条路：
 *   ① 某个 provider 的观测自己报 `complete:false` —— 本机只有 `dsh-skill-filesystem` 会这样：
 *      `watchManager.observeRoots()` 抛错时它 `catch` 住并 `complete = false`（`lib/index.js:93-108`），
 *      抛错点通常是 `replaceWatcher()` 起 watcher 失败（`lib/index.js:306-331`，它还会打一行
 *      `skill-filesystem: failed to watch <根路径>: <错误>` 的 warn —— **但那行 warn 只进内存 buffer、
 *      不落盘，所以本机历史上查不到任何成因**）；
 *   ② 某个 provider 的 `list()` 直接抛错（`collectLayer` 记 `cacheable=false` 并跳过它）；
 *   ③ **revision 竞态**：`collect()` 采集期间 `revision` 变了两次（`MAX_COLLECT_ATTEMPTS = 2`）就
 *      返回 `cacheable:false` —— 此时**候选列表仍然是全的**（实测 10/10 项都在），且没有任何告警。
 *
 * 于是本文件在 v2 之上加了两件事（见下面两节），二者都**只在读取路径上做加法**，不改写路径。
 *
 * ── ① 落盘观测点：`[skill-toggle][INCOMPLETE]` 日志（回答"到底是哪条路"）───────────
 * `snapshot()` 拿到 `complete === false` 时，先逐 provider **单独再读一次**，把成因写 stdout
 * （watchdog 收进 `<工具目录>\dsh-watchdog-dsh.log`）：
 *   · provider 单独读取的结果（`complete` / 候选数）⇒ 若这里为真而合并结果为假，就是 ③ 竞态；
 *   · provider 抛错的 `message` + 栈前几行 ⇒ 对应 ②；
 *   · `dsh-skill-filesystem` 的 `watchManager` 全量根状态（`unhealthy` / `hasWatcher` / `owners`）
 *     ⇒ 对应 ①；对其中 `unhealthy=true` 的根还会**主动重开一次 watcher**并把抛错原文
 *     （`message` + 栈 + 根路径）打出来 —— 这就是历史上一直缺失的那个观测点。
 * 同一实例每 {@link INCOMPLETE_LOG_INTERVAL_MS} 只落一次，避免持续不完整时刷满日志。
 *
 * ── ② 有界兜底重读（只救瞬时竞态，绝不伪造 complete）────────────────────────────
 * `complete === false` 时**再读一次**；只有当第二次独立读取明确回报 `complete === true` 才采用它。
 * 语义依据：`dsh-skill` 自己的注释就是"不完整观测不缓存，留给消费方在下一个请求边界重试"
 * （`dsh-skill/lib/index.js:227-233`）——本插件只是把那次重试提前到本次读取里，让目录**当步**就能下发。
 * 为什么不掩盖真问题：插件**从不自己把 `complete` 改成真**，只转发一次真实读取的结论；
 * provider 真坏了（watcher 起不来、provider 抛错）时两次都是假，结果照旧为假，观测点照旧落盘。
 *
 * ── 生效时机（无需重启 dsh）──────────────────────────────────────────────
 * 过滤发生在**读取结果**上，与注册表的 `collectCache`（键含 revision）无关 ⇒ 改名单后
 * **下一次读取**就是新名单。`dsh-tool-skill` 的 `agent/pre-step` 钩子每个模型步骤都会
 * `snapshot()` 一次并按 digest 决定是否重发目录 ⇒ 观感仍是"下一个模型步骤生效"。
 * `fs.watchFile` 仍保留：状态文件一变就重算一行日志、并调一次 `invalidateCache()` 广播
 * `skills/change`（**保险**：让按 revision 缓存的外部消费者同步刷新，不是生效前提）。
 *
 * ── 影响面（包的是服务实例本身，宿主里所有消费者都受影响）──────────────────
 * 本机实测消费 `ctx.skills` 的地方：
 *   · `dsh-tool-skill` 工具路径：`list()` 里找不到 ⇒ 抛 `skill "X" is unknown or no longer available`；
 *   · `dsh-tool-skill` 的 `/名字` 手势（`agent/pre-step` 里 `get(name)`）：拿到 `undefined` ⇒
 *     `continue` 跳过注入，手势**静默无效**（这正是"三处一起摘"的设计：被禁技能对模型和用户都不可用）；
 *   · `dsh-api-session-controller` 的会话技能列表（`skillRegistry.list({cwd, scope})`）：被禁技能消失。
 * `register` / provider 注册等**写路径一个字都不改**（v1 那套注册代码已整段删除）。
 *
 * ── 边界（刻意不做的事）──
 * · 不注册 provider、不注册模型工具、不出网、不新增端口、不写任何技能文件；
 * · **新增**（v0.3.0，设置页 UI 的配套）：在**共享 `/api` 通道**上注册一条精确 Fetch 路由
 *   {@link STATE_ROUTE}（`ctx.connection.fetch.register`）—— 它自带浏览器信任栅栏与会话鉴权，
 *   不是公开路由；拿不到 `connection` 时只降级（页面显示"接口不可用"），宿主过滤照旧；
 * · 读的文件：状态文件（每次读取调用读一次）+ 技能注册表的读取结果；写的文件只有状态文件
 *   （由 CLI 或设置页的 POST 写，两处共用 {@link toggleDisabledName}，损坏时一律拒绝写）；
 * · 唯一依赖是 Node 标准库（**不 import 任何宿主包**：本插件以 Junction 落进 profile，裸 import
 *   宿主包会 `ERR_MODULE_NOT_FOUND` ⇒ 连 Cordis 的符号都只镜像 `Symbol.for` 常量）；
 * · 诊断只**读**注册表结构（`layers` / `revision`）与 provider 的 `watchManager`，不改它们；
 *   唯一带副作用的一步是"对已 `unhealthy` 的根重开 watcher"，而那正是宿主下一次读取本来就会做的事。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, watchFile, unwatchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名（日志与诊断用）。 */
export const name = 'skill-toggle'

/**
 * 依赖服务：`skills` 缺席时本插件没有存在意义（不注册 = 不加载，也不会抛错拖垮插件树）。
 * 不再需要 `agents`：机制包在注册表实例上，与作用域层无关（见下面"防御性补充"一节）。
 */
export const inject = ['skills']

/** 状态文件名（默认落在 `$DSH_HOME` 下）。 */
export const STATE_FILE_NAME = 'dsh-skill-toggle.json'

/**
 * 设置页 UI 用的状态接口路径。
 *
 * 为什么挂在 `/api` 上：`ctx.connection.fetch` 注册的是**共享 /api 通道上的精确路由**，
 * 于是它天然经过浏览器信任栅栏（Host/Origin 检查）与浏览器会话鉴权（cookie）——
 * 既不用自己实现鉴权，也不像 `ctx.webServer.register` 那样是一条公开路由。
 * 路径形状受 `endpointFromPath('/api', …)` 约束：必须以 `/api/` 开头，且每段只含 `[A-Za-z0-9_$.-]`。
 */
export const STATE_ROUTE = '/api/skill-toggle/state'

/** 状态文件轮询间隔（ms）：`fs.watchFile` 的默认 5007ms 太钝，这里默认 500ms。 */
export const DEFAULT_WATCH_INTERVAL_MS = 500
/** 允许的最小轮询间隔（测试用得到；再小只是徒增 stat 次数）。 */
export const MIN_WATCH_INTERVAL_MS = 20

/**
 * `complete === false` 时的诊断节流间隔（ms）：同一注册表实例最多每 10 秒落盘一次成因。
 * 持续不完整（例如某个 provider 的 watcher 一直起不来）时，每个模型步骤都会触发一次诊断，
 * 不节流会把 watchdog 日志刷满、也会重复做无用的逐 provider 读取。
 */
export const INCOMPLETE_LOG_INTERVAL_MS = 10_000

/** 每个注册表实例上一次落盘"快照不完整"诊断的时间戳（WeakMap：实例没了自动消失）。 */
const incompleteLoggedAt = new WeakMap()

/**
 * 技能名语法，**镜像** `@deepseek-ai/dsh-skill` 的 `SKILL_NAME`（lib/index.js:17）。
 * 必须自己镜像一份：状态文件里的非法条目要在**本插件内**先滤掉，否则"名单里混进一个
 * 大小写/下划线名字"会一路带进下游比较，行为变得难以解释（v1 更是会让整个 provider 被跳过）。
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Cordis 的"原始对象"符号（`Symbol.for('cordis.original')`，见 cordis lib/index.js 的 symbols 表）。
 *
 * `ctx.skills` 拿到的不是裸实例，而是 Cordis 给 Service 包的一层 traceable Proxy：往它身上写
 * **字符串属性**会被 `set` 陷阱落到一层临时 shadow 上（不是实例本身，写了等于没写）⇒ 必须先取回
 * 被包的原对象，再把方法装到原对象上。取法就是读这个符号（`get` 陷阱对它直接返回 target）。
 * 不 import 宿主包，只镜像符号名。
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * 包装记账，挂在**被包的原实例**上：`{ instance, saved, providers, disabled(), restore() }`。
 * 用 `Symbol.for` 而不是模块内局部变量：热重载会重新 import 本模块（换一整套模块作用域），
 * 只有全局符号注册表里的键才能让"新模块实例"认出"这个实例已经被包过了"⇒ 幂等。
 */
const WRAP_STATE = Symbol.for('dsh-skill-toggle.registry-wrap')

/** 被包装的三个方法名（顺序固定，只为日志与遍历稳定）。 */
const WRAPPED_METHODS = ['snapshot', 'list', 'get']

/** 没有名单来源时的兜底读取函数（单例：避免每次包装都造一个新函数，让引用计数失真）。 */
const EMPTY_DISABLED = () => new Set()

/** 默认状态文件路径：`$DSH_HOME\dsh-skill-toggle.json`，`DSH_HOME` 未设时为 `~\.dsh\...`。 */
export function defaultStateFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, STATE_FILE_NAME)
}

/** 错误文本（永不抛：错误对象本身可能是坏的）。 */
function errText(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  try {
    return String(error?.message ?? error)
  } catch {
    return '[无法渲染的错误值]'
  }
}

/** 非 null 的对象或函数。 */
function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** 给日志用的类型描述（`undefined` / `null` 单独说清，别混进 typeof）。 */
function describeValue(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  return typeof value
}

/**
 * 落盘诊断通道：宿主的 stdout/stderr 都被 watchdog 收进 `<工具目录>\dsh-watchdog-dsh.log`
 * （实测 dsh-watchdog.js 把子进程 stdout 与 stderr 一起喂给同一个行缓冲写入器），而
 * `ctx.logger.*` **只进内存 buffer、不落盘**（本机实测：logger 打的告警在日志文件里查不到）
 * ⇒ 关键节点除 logger 之外必须再写一行 `console.*`。
 * 与 {@link safeWarn} 同一纪律：任何失败都吞掉（stdout 也可能不可用），绝不因为打日志而抛错。
 *
 * @param {string} message 一行日志（调用方自带 `[skill-toggle]` 前缀，与本文件既有文案一致）。
 */
function stdoutLog(message) {
  try {
    console.log(message)
  } catch { /* stdout 不可用就算了 */ }
}

/** {@link stdoutLog} 的告警版：走 `console.warn`（同样落进 watchdog 日志）。 */
function stdoutWarn(message) {
  try {
    console.warn(message)
  } catch { /* stdout 不可用就算了 */ }
}

/** 日志：任何失败都吞掉（打日志不该拖垮插件）。 */
function safeWarn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message)
  } catch { /* 日志服务不可用就算了 */ }
  // 落盘诊断：宿主 logger 只进内存 buffer ⇒ 同一行再写一次 stdout，
  // 这样本插件**所有**降级路径（含 apply 抛错、状态文件损坏）都在日志文件里留痕。
  stdoutWarn(message)
}

/**
 * 错误栈的前几行（诊断用，永不抛）。
 *
 * @param {unknown} error 抛出来的东西（可能不是 Error）。
 * @param {number} [maxLines] 最多取几行。
 * @returns {string[]} 已 trim 的栈行；拿不到就返回空数组。
 */
function stackSlice(error, maxLines = 5) {
  try {
    const stack = error?.stack
    if (typeof stack !== 'string' || stack.length === 0) return []
    return stack.split('\n').slice(0, maxLines).map((line) => line.trim()).filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/** 读注册表当前的 revision（诊断用；结构不认识/读不到就返回 undefined）。 */
function revisionOf(instance) {
  try {
    const revision = instance?.revision
    return typeof revision === 'number' ? revision : undefined
  } catch {
    return undefined
  }
}

/**
 * 列出"本次读取会走到"的所有 provider：全局层在前，该 scope 的层链在后（与
 * `SkillRegistry.collectFresh()` 的 `[layers.global, ...layers.chainLayers(scope)]` 同序）。
 *
 * 只读 `layers` / `providers` 这两个公开字段，不 import 宿主包；结构不认识时返回空数组
 * （假注册表、Cordis 换了内部形状都只会让诊断少几行，不会让读取失败）。
 *
 * @param {object} instance 技能注册表原实例。
 * @param {unknown} scope 读取选项里的 `scope`（agent）。
 * @returns {{ layer: number, name: string, provider: object }[]}
 */
function providerTable(instance, scope) {
  const found = []
  try {
    const layers = instance?.layers
    if (!isObject(layers)) return found
    const chain = typeof layers.chainLayers === 'function' ? layers.chainLayers(scope) : []
    const ordered = [layers.global, ...(Array.isArray(chain) ? chain : [])]
    ordered.forEach((layer, index) => {
      const table = layer?.providers
      if (!isObject(table) || typeof table.entries !== 'function') return
      for (const [providerName, entry] of table.entries()) {
        found.push({ layer: index, name: providerName, provider: entry?.provider })
      }
    })
  } catch { /* 结构不认识就算了：诊断少几行，不影响读取 */ }
  return found
}

/**
 * 描述一个 provider 的 `watchManager` 状态 —— 本机只有 `dsh-skill-filesystem` 有这个东西，
 * 它正是"哪个根起不来 watcher"的唯一现场。
 *
 * @param {object} provider provider 实例。
 * @returns {string[]} 每个根一行的可读描述。
 */
function describeWatchManager(provider) {
  const lines = []
  let watchManager
  try {
    watchManager = provider?.watchManager
  } catch (error) {
    return [`读取 watchManager 失败：${errText(error)}`]
  }
  if (!isObject(watchManager)) return lines
  try {
    lines.push(`watchManager: enabled=${watchManager.config?.enabled}`
      + ` projects=${watchManager.projects?.size ?? '?'} roots=${watchManager.roots?.size ?? '?'}`
      + ` closing=${watchManager.closing}`)
    for (const [path, state] of watchManager.roots ?? []) {
      lines.push(`watch 根 ${path} unhealthy=${state?.unhealthy}`
        + ` hasWatcher=${state?.watcher !== undefined} owners=${[...(state?.owners ?? [])].join('|')}`)
    }
  } catch (error) {
    lines.push(`枚举 watchManager 失败：${errText(error)}`)
  }
  return lines
}

/**
 * 对**已经 `unhealthy`** 的根主动重开一次 watcher，把抛错原文（含根路径与栈）拿到手。
 *
 * 为什么这是安全的：`unhealthy=true` 表示宿主自己已经判定这个根的 watcher 坏了、并会在
 * 下一次 `list()` 里尝试 `replaceWatcher()` —— 这里做的**就是同一件事**，只是把结果落盘。
 * 成功时顺带把 watcher 修好了（下一次读取即恢复 `complete=true`）；失败时我们终于拿到了
 * 历史上一直缺失的那句 `failed to watch <根>: <错误>` 的原文。
 *
 * @param {object} provider provider 实例。
 * @returns {Promise<string[]>} 每个不健康的根一到两行。
 */
async function retryUnhealthyWatchers(provider) {
  const lines = []
  let watchManager
  try {
    watchManager = provider?.watchManager
  } catch {
    return lines
  }
  if (!isObject(watchManager) || typeof watchManager.ensureWatcher !== 'function') return lines
  let unhealthy
  try {
    unhealthy = [...(watchManager.roots ?? [])].filter(([, state]) => state?.unhealthy === true)
  } catch {
    return lines
  }
  for (const [path, state] of unhealthy) {
    try {
      await watchManager.ensureWatcher(state)
      lines.push(`对不健康的根主动重开 watcher **成功**：${path}`
        + ' ⇒ 上一次是瞬时失败（继续读取应恢复 complete=true）；若反复出现，看下一行之前的抛错')
    } catch (error) {
      lines.push(`对不健康的根主动重开 watcher 抛错（出错根路径=${path}）：${errText(error)}`)
      for (const line of stackSlice(error)) lines.push(line)
    }
  }
  return lines
}

/**
 * 落盘一次"技能快照不完整"的成因诊断（观测点本体）。
 *
 * 逐 provider 单独读一次 + 逐个 watcher 根看状态，正好覆盖 `complete=false` 的三条可能路径：
 * ① provider 自报不完整（看 `watchManager` 的 `unhealthy` 根 + 主动重开拿抛错原文）；
 * ② provider 抛错（看 `list() 抛错` 那行）；
 * ③ revision 竞态（"单独读取 complete=true 而合并结果 false"）。
 *
 * 只读不写；任何异常都在本函数内吞掉，绝不影响调用方的读取路径。
 *
 * @param {object} instance 技能注册表原实例。
 * @param {object|undefined} options 本次读取的选项（`cwd` / `scope` / `signal`）。
 * @returns {Promise<void>}
 */
async function reportIncompleteSnapshot(instance, options) {
  const lines = [
    '[skill-toggle][INCOMPLETE] 技能快照不完整（complete=false）⇒ dsh-tool-skill 这一步不会下发/重发技能目录。'
    + ` revision=${revisionOf(instance) ?? '?'} cwd=${typeof options?.cwd === 'string' ? options.cwd : '?'}`
    + `（同一实例每 ${INCOMPLETE_LOG_INTERVAL_MS / 1000}s 只落一次；下面逐 provider 给出成因）`,
  ]
  const providers = providerTable(instance, options?.scope)
  if (providers.length === 0) {
    lines.push('[skill-toggle][INCOMPLETE] 拿不到 provider 列表（注册表结构不认识）⇒ 只能报告"不完整"本身')
  }
  for (const { layer, name: providerName, provider } of providers) {
    lines.push(`[skill-toggle][INCOMPLETE] 层${layer} provider=${providerName}`)
    if (!isObject(provider) || typeof provider.list !== 'function') {
      lines.push('[skill-toggle][INCOMPLETE]   provider 没有 list()，跳过')
      continue
    }
    let output
    try {
      output = await provider.list({ cwd: options?.cwd, scope: options?.scope, signal: options?.signal })
    } catch (error) {
      lines.push(`[skill-toggle][INCOMPLETE]   单独读取抛错（路径②）：${errText(error)}`)
      for (const line of stackSlice(error)) lines.push(`[skill-toggle][INCOMPLETE]   ${line}`)
      continue
    }
    const complete = Array.isArray(output) ? true : output?.complete !== false
    const candidates = Array.isArray(output) ? output : output?.candidates
    lines.push(`[skill-toggle][INCOMPLETE]   单独读取：complete=${complete}`
      + ` 候选=${Array.isArray(candidates) ? candidates.length : '?'}`
      + '（这里为 true 而合并结果为 false ⇒ 是路径③ revision 竞态，不是 provider 坏了）')
    for (const line of describeWatchManager(provider)) lines.push(`[skill-toggle][INCOMPLETE]   ${line}`)
    for (const line of await retryUnhealthyWatchers(provider)) lines.push(`[skill-toggle][INCOMPLETE]   ${line}`)
  }
  for (const line of lines) stdoutWarn(line)
}

/**
 * `complete === false` 时的两件事：先落盘成因（观测点），再重读一次做**有界兜底**。
 *
 * 兜底为什么不算"伪造 complete"：只有当**第二次独立读取**明确回报 `complete === true`
 * 时才采用第二次的结果 —— 插件从不自己把 `complete` 改成真。provider 真坏了
 * （watcher 起不来、provider 抛错）时两次都是假，结果照旧为假；只有"采集期间 revision
 * 变了两次"这种瞬时竞态才会被这次重读救回来，而那次重读本来就会发生在消费者的下一个请求边界
 * （`dsh-skill` 的 `collect()` 注释就是这个语义）。重读只做一次，且重读抛错时保留第一次的结果。
 *
 * @param {object} instance 技能注册表原实例。
 * @param {Function} originalSnapshot 包装前的 `snapshot`。
 * @param {object|undefined} options 本次读取的选项。
 * @param {object} first 第一次（不完整）的结果。
 * @param {{ diagnose?: boolean, repairIncomplete?: boolean }} wrapOptions 包装选项。
 * @returns {Promise<object>} 最终结果（可能是 `first`，也可能是重读的结果）。
 */
async function repairIncompleteSnapshot(instance, originalSnapshot, options, first, wrapOptions) {
  if (options?.signal?.aborted === true) return first
  if (wrapOptions.diagnose !== false) {
    try {
      await reportIncompleteSnapshot(instance, options)
    } catch { /* 诊断绝不影响读取路径 */ }
  }
  if (wrapOptions.repairIncomplete === false) return first
  if (options?.signal?.aborted === true) return first
  let retry
  try {
    retry = await originalSnapshot.call(instance, options)
  } catch {
    return first // 重读抛错：保留第一次的结果，绝不把异常带进读取路径
  }
  if (isObject(retry) && retry.complete === true && Array.isArray(retry.skills)) return retry
  return first
}

/**
 * 读状态文件。**只读，绝不写**（损坏时也不覆盖，见 applyInner 里的注释）。
 *
 * @param {string} stateFile 状态文件绝对路径。
 * @returns {{ status: 'ok'|'missing'|'corrupt', names: string[], dropped: unknown[], detail?: string }}
 *   · `ok`      —— 文件可读且形状合法（`{}` 与 `{"disabled":[]}` 都算"空名单"）；
 *   · `missing` —— 文件不存在（ENOENT/ENOTDIR），不是错误，不告警；
 *   · `corrupt` —— 读失败 / JSON 坏 / 顶层不是对象 / `disabled` 不是数组；`detail` 给原因。
 *   `names` 已去重，并已滤掉不是合法技能名的条目（那些进 `dropped`）。
 */
export function readStateFile(stateFile) {
  let raw
  try {
    raw = readFileSync(stateFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'missing', names: [], dropped: [] }
    return { status: 'corrupt', names: [], dropped: [], detail: `读取失败：${errText(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: 'corrupt', names: [], dropped: [], detail: `JSON 解析失败：${errText(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'corrupt', names: [], dropped: [], detail: '顶层必须是一个 JSON 对象' }
  }
  // 没有 disabled 键 = 空名单（不是损坏）：手写一个 `{}` 不该被判成坏文件。
  if (parsed.disabled === undefined) return { status: 'ok', names: [], dropped: [] }
  if (!Array.isArray(parsed.disabled)) {
    return { status: 'corrupt', names: [], dropped: [], detail: '"disabled" 必须是字符串数组' }
  }
  const names = []
  const dropped = []
  for (const entry of parsed.disabled) {
    if (typeof entry === 'string' && SKILL_NAME_RE.test(entry)) {
      if (!names.includes(entry)) names.push(entry)
    } else {
      dropped.push(entry)
    }
  }
  return { status: 'ok', names, dropped }
}

/**
 * 原子写状态文件：先写同目录临时文件再 rename（读者永远看不到半个 JSON）。
 * 只由 CLI / 测试调用 —— 插件本体从不写它。
 *
 * @param {string} stateFile 目标路径（父目录不存在会自动建）。
 * @param {string[]} names 禁用名单（去重；非法名字**抛错**而不是静默丢弃）。
 * @returns {string[]} 实际写入的名单。
 */
export function writeStateFile(stateFile, names) {
  const list = []
  for (const entry of names ?? []) {
    if (typeof entry !== 'string' || !SKILL_NAME_RE.test(entry)) {
      throw new TypeError(`非法技能名 ${JSON.stringify(entry)}（只接受小写 kebab-case，如 my-skill）`)
    }
    if (!list.includes(entry)) list.push(entry)
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  const tmp = `${stateFile}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, `${JSON.stringify({ disabled: list }, null, 2)}\n`, { encoding: 'utf8' })
  try {
    renameSync(tmp, stateFile)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件已不在 */ }
    throw error
  }
  return list
}

/**
 * 读-改-写一次开关：把一个技能名加入/移出禁用名单并原子写回。
 *
 * **设置页 UI 与 CLI 共用这一份语义**（两处各写一遍迟早会漂）：
 * · 文件损坏 ⇒ **拒绝写入**（名单还在坏文件里，覆盖等于把它清空）；
 * · 文件不存在 ⇒ 从**当前生效名单**（即 `config.disabled` 备用注入点）起算，
 *   这样"写文件"这一步不会把备用名单里其它技能悄悄放出来。
 *
 * @param {string} stateFile 状态文件路径。
 * @param {string[]} fallbackDisabled 文件不存在时生效的备用名单（`config.disabled`）。
 * @param {string} name 技能名（必须是合法 kebab-case，否则拒绝）。
 * @param {boolean} enabled `true` = 恢复该技能（移出名单），`false` = 禁用它（加入名单）。
 * @returns {{ ok: true, disabled: string[] } | { ok: false, reason: string }} 写回后的名单，或拒绝原因。
 */
export function toggleDisabledName(stateFile, fallbackDisabled, name, enabled) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return { ok: false, reason: `非法技能名 ${JSON.stringify(name)}（只接受小写 kebab-case，如 my-skill）` }
  }
  const state = readStateFile(stateFile)
  if (state.status === 'corrupt') {
    return { ok: false, reason: `状态文件损坏，拒绝写入（免得把名单清空）：${state.detail}` }
  }
  const before = state.status === 'missing' ? [...(fallbackDisabled ?? [])] : state.names
  const after = enabled
    ? before.filter((entry) => entry !== name)
    : [...new Set([...before, name])].sort()
  return { ok: true, disabled: writeStateFile(stateFile, after) }
}

/**
 * 取**含被禁技能**的完整技能目录（设置页 UI 专用）。
 *
 * 与过滤路径的关系：过滤发生在"读取结果"上（{@link installRegistryFilter}），所以
 * `ctx.skills.snapshot()` 里看不到被禁技能 —— UI 恰恰要看到它们才能给出"打开"的开关。
 * 于是这里从包装记账里取**包装前**的 `snapshot` 直接调用，绕过本插件自己的过滤。
 *
 * 没被包装（插件降级 / 尚未 apply）时退回注册表本身的 `snapshot`，此时目录本来就没有过滤。
 * 任何失败都不抛：调用方拿到 `undefined` 后按"技能列表暂时读不到"处理。
 *
 * @param {object} ctx 插件上下文（只用来取 `ctx.skills`）。
 * @param {object} [options] 读取选项（`cwd` / `scope` / `signal`）。
 * @returns {Promise<{ skills: object[], complete: boolean } | undefined>}
 */
export async function readFullCatalog(ctx, options) {
  let registry
  try {
    registry = ctx?.skills
  } catch {
    return undefined
  }
  const instance = unwrapRegistry(registry)
  if (!isObject(instance)) return undefined
  let snapshot = instance[WRAP_STATE]?.original?.snapshot
  if (typeof snapshot !== 'function') {
    snapshot = typeof instance.snapshot === 'function' ? instance.snapshot : undefined
  }
  if (typeof snapshot !== 'function') return undefined
  const result = await snapshot.call(instance, options ?? {})
  if (!isObject(result) || !Array.isArray(result.skills)) return undefined
  return { skills: result.skills, complete: result.complete !== false }
}

/** 设置页 UI 的只读快照：状态文件三态 + 生效名单 + 完整技能目录。 */
async function collectUiState(ctx, resolved) {
  const state = readStateFile(resolved.stateFile)
  // 生效名单的口径与 currentDisabled() 完全一致（文件权威；缺失/损坏时用备用名单）。
  const disabled = state.status === 'ok' ? state.names : [...resolved.fallbackDisabled]
  const payload = {
    ok: true,
    stateFile: resolved.stateFile,
    status: state.status,
    detail: state.detail ?? null,
    disabled,
    // 文件是否权威 + 是否可写：损坏时 UI 只展示、不给开关（与 CLI 同一条纪律）。
    authoritative: state.status === 'ok',
    writable: state.status !== 'corrupt',
    dropped: state.dropped,
    complete: null,
    skills: [],
    skillsError: null,
  }
  try {
    const catalog = await readFullCatalog(ctx, {})
    if (catalog === undefined) {
      payload.skillsError = '技能目录读不到（注册表不可用或结构不认识）'
    } else {
      payload.complete = catalog.complete
      payload.skills = catalog.skills.map((entry) => ({
        name: typeof entry?.name === 'string' ? entry.name : '',
        description: typeof entry?.description === 'string' ? entry.description : '',
        whenToUse: typeof entry?.whenToUse === 'string' ? entry.whenToUse : '',
        provider: typeof entry?.provider === 'string' ? entry.provider : '',
      })).filter((entry) => entry.name.length > 0)
    }
  } catch (error) {
    payload.skillsError = `技能目录读取抛错：${errText(error)}`
  }
  return payload
}

/** JSON 响应（统一 `no-store`：开关状态必须每次现读）。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * `/api/skill-toggle/state` 的处理器。
 *
 * · `GET`  —— 只读快照（{@link collectUiState}）；
 * · `POST` —— `{ name, enabled }`：读-改-写状态文件（{@link toggleDisabledName}），再回一份新快照。
 *
 * 为什么是"按名字改一个"而不是"整份名单覆盖"：名单的权威在宿主文件上，页面上的副本随时可能过期；
 * 由宿主做读-改-写就不会用旧副本覆盖别人的改动。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} resolved {@link resolveConfig} 的结果。
 * @param {Request} request 入站请求。
 * @returns {Promise<Response>}
 */
async function handleStateRequest(ctx, resolved, request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    try {
      return jsonResponse(await collectUiState(ctx, resolved))
    } catch (error) {
      return jsonResponse({ ok: false, error: `读取失败：${errText(error)}` }, 500)
    }
  }
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400)
  }
  if (!isObject(body) || typeof body.name !== 'string' || typeof body.enabled !== 'boolean') {
    return jsonResponse({ ok: false, error: '请求体必须是 { name: string, enabled: boolean }' }, 400)
  }
  // 名字语法先在**请求层**挡掉（400 = 你请求写错了）；`toggleDisabledName` 里那道同样的检查
  // 是给 CLI 与直接调用者的，命中的是 409（状态不允许写，例如文件损坏）。
  if (!SKILL_NAME_RE.test(body.name)) {
    return jsonResponse({
      ok: false,
      error: `非法技能名 ${JSON.stringify(body.name)}（只接受小写 kebab-case，如 my-skill）`,
    }, 400)
  }
  let result
  try {
    result = toggleDisabledName(resolved.stateFile, resolved.fallbackDisabled, body.name, body.enabled)
  } catch (error) {
    return jsonResponse({ ok: false, error: `写入失败：${errText(error)}` }, 500)
  }
  if (!result.ok) return jsonResponse({ ok: false, error: result.reason }, 409)
  try {
    return jsonResponse(await collectUiState(ctx, resolved))
  } catch (error) {
    return jsonResponse({ ok: false, error: `写入成功但回读失败：${errText(error)}` }, 500)
  }
}

/**
 * 把状态接口挂到共享 `/api` 通道上（`ctx.connection.fetch`）。
 *
 * **必须走 `ctx.inject(['connection'], …)`，不能在 apply 里 `ctx.get('connection')` 读一次就完事**：
 * `connection` 由 `dsh-client-connection` 在 `webServer` 就绪之后才 provide，而加载顺序上本插件
 * 排在它前面 ⇒ apply 那一刻读到的是 `undefined`，且**再也不会重试**。2026-09-28 实测踩过这个坑：
 * 页面能正常打开、拨一下开关报 `HTTP 404`，宿主日志里只有一行"状态接口未注册"。
 * `inject` 是"服务一出现就跑"的挂载点；服务始终缺席（非 web 宿主）时回调根本不执行 ——
 * 这正是要的降级姿态：不报错、不刷日志，宿主过滤一个字都不受影响。
 *
 * 注册归属落在 inject 出来的**子 ctx** 上 ⇒ 插件卸载（或 connection 服务消失）时路由自动摘掉。
 */
function registerStateRoute(ctx, resolved) {
  ctx.inject(['connection'], (connectionCtx) => {
    const registry = connectionCtx.connection?.fetch
    if (typeof registry?.register !== 'function') {
      safeWarn(ctx, '[skill-toggle] 状态接口未注册：connection 服务没有 fetch.register'
        + ' ⇒ 设置页 UI 读不到开关数据（宿主过滤不受影响）')
      return
    }
    try {
      connectionCtx.effect(() => registry.register({
        path: STATE_ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => handleStateRequest(ctx, resolved, request),
      }), 'skill-toggle: 设置页状态接口（/api 共享通道，带浏览器鉴权）')
    } catch (error) {
      safeWarn(ctx, `[skill-toggle] 状态接口注册失败：${errText(error)}`
        + ' ⇒ 设置页 UI 读不到开关数据（宿主过滤不受影响）')
      return
    }
    stdoutLog(`[skill-toggle] 设置页状态接口已注册：${STATE_ROUTE}（GET 读快照 / POST {name,enabled} 改名单）`)
  })
}

/** 规范化 config.disabled：只留合法名字，其余进 dropped。 */
function normalizeDisabled(value) {
  const names = []
  const dropped = []
  if (value === undefined || value === null) return { names, dropped }
  if (!Array.isArray(value)) return { names, dropped: [value] }
  for (const entry of value) {
    if (typeof entry === 'string' && SKILL_NAME_RE.test(entry)) {
      if (!names.includes(entry)) names.push(entry)
    } else {
      dropped.push(entry)
    }
  }
  return { names, dropped }
}

/**
 * 校验并规范化插件 config。
 *
 * @param {object} [config] `{ stateFile?, disabled?, watchIntervalMs?, diagnose?, repairIncomplete? }`。
 *   · `stateFile` —— 状态文件路径，默认 {@link defaultStateFile}（**测试用临时路径注入它**）；
 *   · `disabled`  —— 备用注入点（默认空）。**状态文件是权威来源**：文件存在 ⇒ 完全以文件为准，
 *     `disabled` 只在文件**不存在**（或损坏）时生效；两者**不相加**（否则会出现"文件里删了名字
 *     却依然禁用"的困惑）；
 *   · `watchIntervalMs` —— 状态文件轮询间隔，默认 500ms，下限 20ms（只影响"变化即重算日志 +
 *     invalidate 广播"的灵敏度；过滤本身每次读取都现读文件，不依赖它）；
 *   · `diagnose` —— 默认 `true`：`complete=false` 时逐 provider 落盘成因（观测点）；
 *   · `repairIncomplete` —— 默认 `true`：`complete=false` 时重读一次，仅当重读明确
 *     `complete=true` 才采用（**从不自己伪造 complete**，见 repairIncompleteSnapshot）。
 */
export function resolveConfig(config) {
  const cfg = config ?? {}
  const stateFile = typeof cfg.stateFile === 'string' && cfg.stateFile.length > 0 ? cfg.stateFile : defaultStateFile()
  const fallback = normalizeDisabled(cfg.disabled)
  const watchIntervalMs = Number.isSafeInteger(cfg.watchIntervalMs) && cfg.watchIntervalMs >= MIN_WATCH_INTERVAL_MS
    ? cfg.watchIntervalMs
    : DEFAULT_WATCH_INTERVAL_MS
  return {
    stateFile,
    fallbackDisabled: fallback.names,
    fallbackDropped: fallback.dropped,
    watchIntervalMs,
    diagnose: cfg.diagnose !== false,
    repairIncomplete: cfg.repairIncomplete !== false,
  }
}

/**
 * 取回 Cordis traceable Proxy 背后的原对象；本来就不是 Proxy 就原样返回。
 *
 * 为什么必须做：`ctx.skills` 是 Proxy，往 Proxy 上写字符串属性**不会**落到实例上（见
 * {@link CORDIS_ORIGINAL} 的注释）—— 那会让"包装成功"变成一句空话。测试里传进来的假
 * registry（普通对象）没有这个符号，原样返回即可。
 *
 * @param {unknown} value 候选注册表对象。
 * @returns {unknown} 原对象（不是对象时原样返回）。
 */
export function unwrapRegistry(value) {
  if (!isObject(value)) return value
  try {
    const original = value[CORDIS_ORIGINAL]
    if (isObject(original)) return original
  } catch { /* 取不到（例如带陷阱的对象）就按原对象处理 */ }
  return value
}

/** 沿原型链找属性描述符（`snapshot` 这类方法在类的原型上，不在实例自身上）。 */
function findDescriptor(target, key) {
  let cursor = target
  while (isObject(cursor)) {
    const desc = Object.getOwnPropertyDescriptor(cursor, key)
    if (desc !== undefined) return desc
    cursor = Object.getPrototypeOf(cursor)
  }
  return undefined
}

/** 条目是不是"被禁名单里的技能"（只认字符串名字；名字缺失的条目一律保留）。 */
function isDisabledEntry(entry, disabled) {
  return isObject(entry) && typeof entry.name === 'string' && disabled.has(entry.name)
}

/**
 * 在实例上装三个过滤方法。**只装一次**（调用方先查 {@link WRAP_STATE}），失败时抛错由调用方兜住。
 *
 * @param {object} instance 技能注册表**原实例**。
 * @param {{ diagnose?: boolean, repairIncomplete?: boolean }} wrapOptions 包装选项（只作用于
 *   `snapshot` 的不完整分支；同一实例第二次包装时沿用第一次的选项）。
 * @returns {object} 包装记账（作为 `instance[WRAP_STATE]` 挂上去）。
 */
function installRegistryFilter(instance, wrapOptions) {
  /** key → `{ own, descriptor, value }`：`own` 决定还原方式（自有属性写回 / 原型方法删掉自有属性）。 */
  const saved = new Map()
  for (const key of WRAPPED_METHODS) {
    const ownDesc = Object.getOwnPropertyDescriptor(instance, key)
    const desc = ownDesc ?? findDescriptor(instance, key)
    saved.set(key, {
      own: ownDesc !== undefined,
      descriptor: ownDesc,
      value: typeof desc?.value === 'function' ? desc.value : undefined,
    })
  }

  const state = {
    instance,
    /** 这次真装上了哪些方法（原方法缺失的不装，`get` 尤其可能不存在）。 */
    installed: [],
    /** 存活的包装者：`read()` → 引用计数。多个 apply/多个视图共用同一份 `read` 时只算一次读取。 */
    providers: new Map(),
    /**
     * 当前被禁名单 = 所有存活包装者读出来的**并集**（每次调用现算，绝不缓存）。
     * 正常只有一个包装者；两个 apply 同时活着时取并集，语义是"谁的名单都算数"。
     */
    disabled() {
      const names = new Set()
      for (const read of state.providers.keys()) {
        let value
        try {
          value = read()
        } catch {
          continue // currentDisabled() 自己吞异常；真抛了就当这一份是空名单，绝不连累读取
        }
        if (value === undefined || value === null) continue
        for (const entry of value) names.add(entry)
      }
      return names
    },
    /** 还原：自有属性写回原描述符；原本来自原型的方法删掉自有属性即可（原型上那份从没被动过）。 */
    restore() {
      for (const [key, entry] of saved) {
        try {
          if (entry.value === undefined) continue // 本来就没有这个方法：不碰
          if (entry.own) Object.defineProperty(instance, key, entry.descriptor)
          else delete instance[key]
        } catch { /* 还原失败也不能抛（卸载路径） */ }
      }
      try {
        delete instance[WRAP_STATE]
      } catch { /* 标记删不掉也不影响功能 */ }
    },
  }

  const originalSnapshot = saved.get('snapshot').value
  if (originalSnapshot !== undefined) {
    state.installed.push('snapshot')
    instance.snapshot = async function snapshot(options) {
      let result = await originalSnapshot.call(instance, options)
      // 不完整 ⇒ 先落盘成因（观测点），再重读一次（有界兜底）。见文件头两节。
      if (isObject(result) && result.complete === false) {
        result = await repairIncompleteSnapshot(instance, originalSnapshot, options, result, wrapOptions)
      }
      const disabled = state.disabled()
      if (disabled.size === 0 || !isObject(result) || !Array.isArray(result.skills)) return result
      const kept = result.skills.filter((entry) => !isDisabledEntry(entry, disabled))
      // 一条都没被滤掉时返回**原对象**（保持身份不变，方便调用方做引用比较）。
      return kept.length === result.skills.length ? result : { ...result, skills: kept }
    }
  }

  const originalList = saved.get('list').value
  if (originalList !== undefined) {
    state.installed.push('list')
    instance.list = async function list(options) {
      const result = await originalList.call(instance, options)
      const disabled = state.disabled()
      if (disabled.size === 0 || !Array.isArray(result)) return result
      const kept = result.filter((entry) => !isDisabledEntry(entry, disabled))
      return kept.length === result.length ? result : kept
    }
  }

  const originalGet = saved.get('get').value
  if (originalGet !== undefined) {
    state.installed.push('get')
    instance.get = async function get(name, options) {
      // 名单里的名字直接判死：被禁技能不该能被 `skill` 工具或 `/名字` 手势加载。
      if (typeof name === 'string' && state.disabled().has(name)) return undefined
      return await originalGet.call(instance, name, options)
    }
  }

  // 包装前的方法本体留在记账里：设置页 UI 要的是**含被禁技能**的完整目录，
  // 只能从这里绕过去（走 instance.snapshot 会被本插件自己的过滤摘掉）。
  state.original = { snapshot: originalSnapshot, list: originalList, get: originalGet }

  return state
}

/**
 * 给技能注册表包一层"过滤被禁技能"的方法（**幂等**：同一实例只包一次）。
 *
 * 返回的句柄必须交给 `ctx.effect` 的清理函数释放 —— 释放是引用计数式的：只有当这个实例上的
 * 包装者全部释放后，才会把原方法装回去（`snapshot` 等三个方法恢复成包装前的样子）。
 *
 * @param {object} registry 技能注册表（`ctx.skills` 这个 Cordis traceable Proxy，或测试里的假对象）。
 * @param {() => Set<string>} getDisabled 取当前禁用名单的函数；**每次读取都会调用它**（不缓存名单）。
 * @param {{ diagnose?: boolean, repairIncomplete?: boolean }} [options] 不完整分支的开关
 *   （默认都开；测试用它静音诊断日志 / 关掉兜底重读）。
 * @returns {{ ok: boolean, instance?: object, already?: boolean, wrappedMethods?: string[],
 *   reason?: string, release: () => void }}
 *   · `ok:false` —— 注册表不可用/装不上（`reason` 给原因），调用方只该降级并留一行日志；
 *   · `already` —— 该实例此前已被包过，本次只登记了一个名单来源（没有叠第二层包装）。
 */
export function wrapSkillRegistry(registry, getDisabled, options) {
  const instance = unwrapRegistry(registry)
  if (!isObject(instance)) {
    return {
      ok: false,
      already: false,
      reason: `技能注册表不可用（registry=${describeValue(registry)}）`,
      release() {},
    }
  }

  let state = instance[WRAP_STATE]
  const already = state !== undefined
  if (!already) {
    try {
      state = installRegistryFilter(instance, options ?? {})
      Object.defineProperty(instance, WRAP_STATE, {
        value: state,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    } catch (error) {
      return {
        ok: false,
        instance,
        already: false,
        reason: `在技能注册表上装过滤方法失败：${errText(error)}`,
        release() {},
      }
    }
  }

  const read = typeof getDisabled === 'function' ? getDisabled : EMPTY_DISABLED
  state.providers.set(read, (state.providers.get(read) ?? 0) + 1)

  let released = false
  return {
    ok: true,
    instance,
    already,
    wrappedMethods: [...state.installed],
    release() {
      if (released) return
      released = true
      const count = state.providers.get(read)
      if (count === undefined) return
      if (count > 1) state.providers.set(read, count - 1)
      else state.providers.delete(read)
      // 所有包装者都走了 ⇒ 把原方法装回去（同时删掉 WRAP_STATE，之后可以重新包装）。
      if (state.providers.size === 0) state.restore()
    },
  }
}

/**
 * 盯住状态文件：内容一变就回调（默认用来打一行重算日志 + `invalidateCache()`）。
 * 用 `fs.watchFile`（stat 轮询）而不是 `fs.watch`：状态文件可能**还不存在**（创建时也要触发），
 * 且轮询不依赖目录事件语义，Windows 上更稳。`persistent:false` ⇒ 不阻止进程退出（测试友好）。
 *
 * @returns {() => void} 停止监听的幂等函数。
 */
function watchStateFile(stateFile, intervalMs, onChange, onError) {
  const listener = (current, previous) => {
    // 只认"真的变了"：mtime 与 size 都没动就不打扰（避免无意义的重算与目录重发）。
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
    try {
      onChange()
    } catch (error) {
      onError?.(error)
    }
  }
  try {
    watchFile(stateFile, { persistent: false, interval: intervalMs }, listener)
  } catch (error) {
    onError?.(error)
    return () => {}
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    try { unwatchFile(stateFile, listener) } catch { /* 已经停了 */ }
  }
}

/**
 * Cordis 插件入口。**apply 绝不把异常抛回 loader**：本机已有教训 —— 插件加载失败会让
 * 整个 dsh 起不来（新进程每次都在打印启动行之前崩掉，表现为浏览器一直卡"启动中"）。
 * 任何意外都只降级（禁用名单不生效）并留一行日志。
 */
export function apply(ctx, config) {
  try {
    applyInner(ctx, config)
  } catch (error) {
    // 降级路径也必须**落盘**：safeWarn 除 logger 之外还会写一行 stdout（见其实现）
    // ⇒ 哪怕 applyInner 在第一行就抛错，watchdog 日志里也一定有一行 `[skill-toggle]`。
    safeWarn(ctx, `[skill-toggle] apply 抛错，插件已降级（禁用名单本次不生效）：${errText(error)}`)
  }
}

function applyInner(ctx, config) {
  const resolved = resolveConfig(config)

  // ── 0) 落盘诊断（本插件的第一行日志）：判定"bundle 是否真的进了运行树"的唯一凭据 ──────
  // · 这行**不在**日志里 ⇒ 可能性 (a)：本包压根没被加载（profile 的 dsh.profile.bundles
  //   没读到本包名，或本包 patch 文件缺失 ⇒ loadProfileDirectory 静默跳过），与包装成败无关；
  // · 这行**在**、但下面没有"机制就绪" ⇒ 可能性 (b)：进了树，但注册表包装失败（原因见紧邻的告警行）。
  // 状态位沿用读文件的三态（ok/missing/corrupt）：missing 时名单来自 config.disabled。
  const bootState = readStateFile(resolved.stateFile)
  const bootNames = bootState.status === 'ok' ? bootState.names : resolved.fallbackDisabled
  stdoutLog(`[skill-toggle] >>> APPLY 进入 <<< stateFile=${resolved.stateFile} 状态=${bootState.status}`
    + ` 名单=${bootNames.length} 条 ${JSON.stringify(bootNames)}`
    + ` 不完整快照：诊断=${resolved.diagnose ? '开' : '关'} 兜底重读=${resolved.repairIncomplete ? '开' : '关'}`)

  /** 同一类问题只打一行日志（读取每个模型步骤都会发生一次，不能刷屏）。 */
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    safeWarn(ctx, `[skill-toggle] ${message}`)
  }

  // ── 1) 名单：每次读取现读文件 ───────────────────────────────────────────────
  let lastCorruptDetail = null
  const currentDisabled = () => {
    const state = readStateFile(resolved.stateFile)
    let names
    if (state.status === 'corrupt') {
      // 损坏 ⇒ 视为空名单（**全部启用**，fail-open：宁可技能照旧可用，也不要因为一个坏文件
      // 让模型看不见任何技能）。**绝不覆盖写坏文件**：名单还在里面，覆盖等于把它清空。
      names = resolved.fallbackDisabled
      if (lastCorruptDetail !== state.detail) {
        lastCorruptDetail = state.detail
        safeWarn(ctx, `[skill-toggle] 状态文件不可用（${state.detail}）⇒ 本次按"全部启用"处理，且不会覆盖该文件`)
      }
    } else {
      lastCorruptDetail = null
      // 文件存在（哪怕是空名单）⇒ 完全以文件为准；只有文件不存在时才用 config.disabled。
      names = state.status === 'missing' ? resolved.fallbackDisabled : state.names
    }
    if (state.dropped.length > 0) {
      warnOnce(
        `dropped:${JSON.stringify(state.dropped)}`,
        `状态文件里有 ${state.dropped.length} 条不是合法技能名的条目，已忽略：${JSON.stringify(state.dropped)}`,
      )
    } else {
      for (const key of [...warned]) if (key.startsWith('dropped:')) warned.delete(key)
    }
    return new Set(names)
  }

  // ── 2) 包装技能注册表：机制本体 ────────────────────────────────────────────
  /** 本次 apply 建立的包装句柄（卸载时逐个释放；同一实例上的多个句柄由引用计数合并）。 */
  const handles = []

  const wrapOptions = { diagnose: resolved.diagnose, repairIncomplete: resolved.repairIncomplete }

  const wrapOn = (registry, label) => {
    const handle = wrapSkillRegistry(registry, currentDisabled, wrapOptions)
    if (!handle.ok) {
      stdoutWarn(`[skill-toggle] ${label} 包装跳过：${handle.reason} ⇒ 被禁技能摘不掉`)
      return undefined
    }
    handles.push(handle)
    return handle
  }

  const rootHandle = wrapOn(ctx.skills, '技能注册表(ctx.skills)')
  if (rootHandle !== undefined) {
    stdoutLog(`[skill-toggle] 机制就绪：技能注册表已包装，方法=[${rootHandle.wrappedMethods.join(', ')}]`
      + `${rootHandle.already ? '（该实例此前已被包装，本次只登记名单来源，不叠层）' : ''}`
      + ` ⇒ 被禁技能会在每次读取结果里被过滤；当前名单 ${bootNames.length} 条 ${JSON.stringify(bootNames)}`)
  } else {
    stdoutWarn('[skill-toggle] 机制未就绪：ctx.skills 包装失败（原因见上一行）⇒ 禁用名单本次不生效')
  }

  // ── 2.5) 设置页 UI 的状态接口：挂到共享 /api 通道（带浏览器鉴权）──────────────────
  // 与过滤机制**完全解耦**：它只读状态文件 + 读"含被禁技能"的完整目录，写名单也走同一份
  // toggleDisabledName。注意这里是 `ctx.inject`（服务一出现就跑）而不是一次性 `ctx.get`
  // —— `connection` 比本插件晚就绪，一次性读取会永远拿到 undefined（见 registerStateRoute）。
  registerStateRoute(ctx, resolved)

  // ── 3) 防御性补充：agent 视图解析到"另一份"注册表实例时也包上 ──────────────────
  // 宿主正常只有一份 skills 服务实例（本机 web profile 实测：`skill` 工具、会话目录、Web 技能列表
  // 三条路径都走它）⇒ 这一节通常是空操作。但 `agentPresets.serviceFor(agent, 'skills')`
  // （dsh-api-session-controller:2293 先查它、再回落 `ctx.get('skills')`）说明"某个 preset 自挂
  // 一份 dsh-skill"是合法形态；那种形态下 agent 视图解析到的是**另一份实例**，只包 ctx.skills 会漏。
  // 解析到同一实例时 `wrapSkillRegistry` 幂等返回（`already:true`），不会叠层、也不会多读文件。
  /** 已经解析过的 agent（WeakSet：agent 对象没了就自动消失）。 */
  const syncedAgents = new WeakSet()

  const syncAgentViews = () => {
    let agents
    try {
      agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    } catch {
      agents = undefined
    }
    // 拿不到 agents 是**正常形态**（核心机制不需要它）⇒ 只留 debug，不落盘刷日志。
    if (agents === undefined || agents === null || typeof agents.list !== 'function') {
      try {
        ctx?.logger?.debug?.('[skill-toggle] 拿不到 agents 服务，跳过 agent 视图检查（只包了 ctx.skills）')
      } catch { /* 日志不可用就算了 */ }
      return
    }
    let live
    try {
      live = agents.list()
    } catch (error) {
      warnOnce(`agents:${errText(error)}`, `枚举活跃 agent 失败（只影响"preset 自挂注册表"的兜底覆盖）：${errText(error)}`)
      return
    }
    if (!Array.isArray(live)) {
      stdoutWarn(`[skill-toggle] 跳过 agent 视图检查：agents.list() 返回的不是数组（实际 ${describeValue(live)}）`
        + ' ⇒ 只包了 ctx.skills；若某个 preset 自挂一份 dsh-skill，那份实例里的技能不会被摘')
      return
    }
    for (const agent of live) {
      if (!isObject(agent) || syncedAgents.has(agent)) continue
      let view
      try {
        view = agent.ctx?.get?.('skills')
      } catch (error) {
        warnOnce(`agentview:${errText(error)}`, `读取 agent ${agent.id ?? '?'} 的技能视图失败：${errText(error)}`)
        continue
      }
      if (view === undefined || view === null) continue
      syncedAgents.add(agent)
      const handle = wrapOn(view, `agent:${agent.id ?? '?'} 的技能视图`)
      // 解析到同一实例（正常形态）时 already=true，一个字都不打；真出现另一份实例才落一行。
      if (handle !== undefined && !handle.already) {
        stdoutWarn(`[skill-toggle] agent ${agent.id ?? '?'} 的技能视图是**另一份**注册表实例（preset 自挂 dsh-skill？）`
          + ` ⇒ 已一并包装，方法=[${handle.wrappedMethods.join(', ')}]`)
      }
    }
  }

  syncAgentViews()
  // `agent/created` 是**串行**事件且监听器被 await：抛错会让整个 agent 创建失败 ⇒ 一个异常都不许外泄。
  ctx.on('agent/created', () => {
    try {
      syncAgentViews()
    } catch (error) {
      safeWarn(ctx, `[skill-toggle] 新 agent 视图检查失败（只影响 preset 自挂注册表的兜底覆盖）：${errText(error)}`)
    }
  })
  ctx.on('agent/disposed', (payload) => {
    try {
      if (isObject(payload?.agent)) syncedAgents.delete(payload.agent)
    } catch { /* 记账失败无所谓 */ }
  })

  // ── 4) 状态文件变化 ⇒ 重算一行日志 + 广播 skills/change（保险，不是生效前提）────────
  /** 让注册表丢掉合并缓存并广播 `skills/change`（过滤发生在读取结果上，不依赖这一步）。 */
  const invalidateAll = () => {
    for (const handle of handles) {
      try {
        handle.instance?.invalidateCache?.()
      } catch (error) {
        warnOnce(`invalidate:${errText(error)}`, `invalidateCache 失败（只是刷新广播失败，过滤不受影响）：${errText(error)}`)
      }
    }
  }

  const stopWatching = watchStateFile(
    resolved.stateFile,
    resolved.watchIntervalMs,
    () => {
      // 这一行是"改名单了"的落盘凭据：名单每次读取现读文件 ⇒ 下一次读取就是新名单。
      const state = readStateFile(resolved.stateFile)
      const names = state.status === 'ok' ? state.names : resolved.fallbackDisabled
      stdoutLog(`[skill-toggle] 状态文件变化 ⇒ 名单重算：状态=${state.status} 名单=${names.length} 条 ${JSON.stringify(names)}`
        + '（过滤在读取结果上，下一次读取即生效；随后再 invalidate 一次让按 revision 缓存的外部消费者同步刷新）')
      invalidateAll()
    },
    (error) => warnOnce(`watch:${errText(error)}`, `监听状态文件失败（改名后只是少了一行重算日志，过滤照旧生效）：${errText(error)}`),
  )

  // ── 5) 卸载：停监听 + 把原方法装回去 ───────────────────────────────────────
  // 包的是宿主共享的服务实例 ⇒ 卸载必须还原，否则热重载/停用插件后过滤会一直留着。
  // 引用计数：同一实例上的多个句柄全部释放后才真正还原（见 wrapSkillRegistry 的 release）。
  ctx.effect(() => () => {
    stopWatching()
    for (const handle of handles.splice(0)) {
      try {
        handle.release()
      } catch { /* 卸载路径不再刷日志 */ }
    }
  }, 'skill-toggle: 还原技能注册表方法并停掉状态文件监听')
}
