# dsh-skill-toggle

DSH 插件：按一份**禁用名单**把指定技能从模型可见的技能目录里摘掉，随时可恢复。
**不改任何技能文件**（连技能目录都不读，只认名字），改名单后**下一次读取**就是新名单，无需重启 dsh。

两半：

- **宿主半身**（`lib/index.js`）—— 过滤机制本体 + 给 UI 用的状态接口；
- **浏览器半身**（`lib/client.js`）—— 「**设置 → 技能开关**」里给每个技能一个开关（v0.3.0 新增）。

它解决的问题：`~\.dsh\skills\` 下的技能目前无条件出现在每个会话的技能目录（注入模型的
`<available_skills>` 块），用户需要一个开关按需摘掉某几个，而不必删文件、改 frontmatter 或换 profile。

## 它做什么（结论）

- 名单里的技能名，会被**从技能注册表的读取结果里滤掉**：`snapshot()` / `list()` 的结果里整条消失，
  `get(名字)` 直接返回 `undefined`。
- 于是三处一起摘掉：模型目录（`<available_skills>`）、`skill` 工具、用户 `/名字` 手势。
- 把名字从名单里删掉即恢复；技能文件、frontmatter、目录结构一律不动。

## 设置页 UI：每个技能一个开关（v0.3.0）

**在哪**：侧边栏底部「设置」→ 左侧导航最下面一节「**技能开关**」（`settings.section` 座位，`id: skill-toggle`）。

**长什么样**：一行一个技能 —— 名字 + 来源 provider + 描述（最多两行）+ 右侧一个开关
（`role="switch"` + `aria-checked`，轨道/滑块照宿主同类控件，只用 `--dsw-*` 主题令牌）。
被关掉的行整体变灰；顶部一行「共 N 个技能 · 已关 M 个」+ 刷新按钮；底部一行写明改动写进哪个文件。

```
技能开关
关掉的技能会从模型看到的技能目录（<available_skills>）、`skill` 工具与 `/名字` 手势里一起消失…
──────────────────────────────────────────────────────────────
共 12 个技能 · 已关 1 个                                    [ 刷新 ]
  brainstorming      filesystem   在任何创造性工作之前或需求模糊时使用…      ( ●)
  godot-use          filesystem   用 godot MCP 工具集操作 Godot 项目…        (  ○)  ← 已关
  readme-generator   filesystem   为项目生成高质量的 README.md 文件…        ( ●)
──────────────────────────────────────────────────────────────
改动写入 %USERPROFILE%\.dsh\dsh-skill-toggle.json，在下一个模型步骤生效，不需要重启。
```

**它怎么和宿主说话**：宿主半身在**共享 `/api` 通道**上注册一条精确 Fetch 路由
`/api/skill-toggle/state`（`ctx.connection.fetch.register`），页面直接 `fetch` 它：

| 方法 | 作用 |
| --- | --- |
| `GET` | 状态文件三态 + 生效名单 + **含被禁技能**的完整技能目录 |
| `POST` | `{ name, enabled }` —— 由宿主**读-改-写**状态文件，再回一份新快照 |

三条设计取舍：

- **走 `/api` 而不是 `ctx.webServer.register`**：`/api` 通道自带浏览器信任栅栏（Host/Origin 检查）与
  会话 cookie 鉴权 —— 本插件不自己实现鉴权，也不开一条公开路由；拿不到 `connection` 服务时只降级
  （页面显示"读不到"，宿主过滤照旧），并留一行告警。
- **POST 是"按名字改一个"而不是"整份名单覆盖"**：名单的权威在宿主文件上，页面副本随时可能过期，
  由宿主做读-改-写就不会用旧副本覆盖别人的改动（CLI 与 UI 共用 `toggleDisabledName` 这一份语义）。
- **列表里必须能看到被禁技能**：过滤发生在读取结果上，所以 UI 走的是包装记账里**包装前**的
  `snapshot`（`readFullCatalog`），绕过本插件自己的过滤 —— 否则关掉的技能会从列表里消失，再也打不开。

**UI 做不到的（明确边界）**：

- 只列**全局视角**的技能（用户根 + 内置根），不带 `cwd` ⇒ 某个工作区里 `.dsh/skills` 的项目技能
  不在列表里（本机工作区没有项目技能，所以看不到差别）。要改名单里的项目技能名，用 CLI。
- 状态文件**损坏**时页面只读：开关全部禁用 + 一条说明。这与 CLI 同一条纪律 —— 名单还在坏文件里，
  覆盖写等于把它清空。
- 名单里有、当前不存在的陌生名字**照旧列出来**（标注"当前没有这个技能"），否则用户没法把它清掉。
- 技能目录这次不完整（宿主回报 `complete === false`）时列表可能缺项，页面顶部会挂一条提示。

**踩过的坑（2026-09-28 实测；两条都会让人以为"UI 坏了"）**：

1. **装完必须刷新页面**。客户端模块图是**页面加载时**烘进 `window.__DSH_BOOT__` 的：宿主重启后新模块
   已经在图里，但那个**已经开着的旧标签页**还拿着旧图 ⇒ 设置里看不到「技能开关」。F5 一下就有。
   （宿主侧改 `lib/*.js` 仍要重启 —— 两件事都得做，缺一个都看不到。）
2. **注册路由必须用 `ctx.inject(['connection'], …)`，不能在 apply 里 `ctx.get('connection')` 读一次**。
   `connection` 由 `dsh-client-connection` 在 `webServer` 就绪**之后**才 provide，加载顺序上本插件排在
   它前面 ⇒ 一次性读取永远拿到 `undefined` 且不再重试。症状极具误导性：**页面正常打开、导航里也有
   「技能开关」，只有点进去报 `HTTP 404`**（`/api` 路由在，只是没人接这条路径），宿主日志里只有一行
   "状态接口未注册"。`inject` 是"服务一出现就跑"，服务始终缺席（非 web 宿主）时回调根本不执行 ——
   正是要的降级姿态。回归用例：`test/ui-state.test.mjs` 的「connection 服务**晚到**也照样注册上」。


## 机制：包一层技能注册表实例（v2）

在 `ctx.skills`（`@deepseek-ai/dsh-skill` 的 `SkillRegistry` **实例**）上装三个自有方法，
先调原方法、再过滤结果：

| 方法 | 包装后行为 |
| --- | --- |
| `snapshot(options)` | 滤掉 `skills` 数组里名字在名单里的条目；`complete` 等其它字段原样保留 |
| `list(options)` | 同理（宿主实现就是 `(await this.snapshot(options)).skills`；两条都包是保险，过滤幂等） |
| `get(name, options)` | 名字在名单里**直接返回 `undefined`**；否则原样转发给原方法 |

配套约定：

- **名单每次调用现读状态文件**（`currentDisabled()`），不缓存在闭包里 ⇒ 改文件后下一次读取即生效；
- **幂等**：同一实例只包一次（`Symbol.for('dsh-skill-toggle.registry-wrap')` 记账，热重载换了模块
  实例也认得出）；重复 apply 只登记名单来源，不叠第二层；
- **卸载还原**：`ctx.effect` 的清理函数把原方法装回去（原本来自原型的方法删掉自有属性即可），
  同时停掉 `fs.watchFile`；同一实例上多个包装者按引用计数，全部释放后才还原；
- **只包读路径**：`registerProvider` / `register` 等写路径与其它属性一个字都不动。

### 为什么不用"同名占位候选"（v1，已删除）

v1 注册一个同名占位 provider（`invocation.modelInvocable=false`、rank **-1e9**），指望
"注册表逐层合并时近层同名盖远层"压住真身。2026-09-28 凌晨 8 次宿主重启 + 探针实测（证据在
`<工具目录>\dsh-watchdog-dsh.log`，探针行前缀 `[skill-toggle]`）证明它**压不住**：

- 占位 provider 确实注册成功、每次 collect 也确实被调用（`provider.list()` 有日志）；
- 但它**输在同一层内的去重**上：探针打出的 `层4 providers=[skill-toggle,filesystem]` 里
  `readme-generator` 胜出的是 `filesystem(rank=400, modelInvocable=true)` —— 占位 rank=-1e9
  本该更小（`dsh-skill` 的 `collectLayer` 按 rank 升序排序后按名字去重）。原因未定，不再深挖；
- 自检同样证明没摘掉：`complete=false 共10项 含readme-generator=true 该项provider=filesystem`。

⇒ **不能依赖合并/去重规则**。包装读取结果不参与任何层合并与去重，宿主内部怎么合并都拦得住；
这也是本插件现在**不需要**知道技能来自哪一层、**不需要** `agents` 服务的原因。

## `complete === false`：技能目录整场不下发的观测点与兜底（v0.2.0，2026-09-28）

**症状**：某些会话整场看不到 `<available_skills>` 块（见下面「活体验收」里那条待补结论）。
原因不在本插件，而在上游的一条门 —— `dsh-tool-skill` 的 `agent/pre-step` 第一道门是

```js
const snapshot = await ctx.skills.snapshot({ cwd, signal, scope: agent })
if (!snapshot.complete) return decision      // ← 这一步既不下发、也不重发目录
```

（`dsh-tool-skill/lib/index.js:207-216`）。`complete` 来自 `SkillRegistry.collect()` 的
`cacheable`，被置假只有三条路：

| 路径 | 现场 | 特征 |
| --- | --- | --- |
| ① provider 自报不完整 | 本机只有 `dsh-skill-filesystem`：`watchManager.observeRoots()` 起 watcher 抛错时它 `catch` 住并 `complete=false`（`lib/index.js:93-108`） | 候选列表**是全的**；上游那行 `failed to watch <根>: <错误>` 的 warn **只进内存 buffer、不落盘**（本机历史上因此查不到任何成因） |
| ② provider 的 `list()` 抛错 | `collectLayer` 记 `cacheable=false` 并跳过该 provider | 该 provider 的候选**整批消失** |
| ③ revision 竞态 | `collect()` 采集期间 `revision` 变了两次（`MAX_COLLECT_ATTEMPTS = 2`） | 候选列表**是全的**、**没有任何告警**；隔离进程实测把 `invalidateCache()` 打到 1ms 一次时，10/10 次都是 `complete=false` 且 10 项技能全在 |

本插件为此加了两件事（都只在读取路径上做加法，不改写路径）：

1. **落盘观测点**：`snapshot()` 拿到 `complete=false` 时，逐 provider **单独再读一次**并把成因写 stdout
   （watchdog 收进 `<工具目录>\dsh-watchdog-dsh.log`，行前缀 `[skill-toggle][INCOMPLETE]`）：
   provider 单独读取的 `complete`/候选数、provider 抛错的 message + 栈、`dsh-skill-filesystem`
   的 `watchManager` 全量根状态（`unhealthy` / `hasWatcher` / `owners`），并对 `unhealthy=true` 的根
   **主动重开一次 watcher** 把抛错原文（message + 栈 + 根路径）打出来。同一实例每 10s 只落一次。
   隔离进程实测样张（真实 provider + 人为造的 watcher 失败）：

   ```
   [skill-toggle][INCOMPLETE] 技能快照不完整（complete=false）… revision=1 cwd=…
   [skill-toggle][INCOMPLETE] 层0 provider=filesystem
   [skill-toggle][INCOMPLETE]   单独读取：complete=false 候选=1（这里为 true 而合并结果为 false ⇒ 是路径③ revision 竞态，不是 provider 坏了）
   [skill-toggle][INCOMPLETE]   watch 根 C:\…\loop-a\skills unhealthy=true hasWatcher=false owners=shared:C:\…\loop-a\skills
   [skill-toggle][INCOMPLETE]   对不健康的根主动重开 watcher 抛错（出错根路径=C:\…\loop-a\skills）：ELOOP: too many symbolic links encountered, stat 'C:\…\loop-a'
   [skill-toggle][INCOMPLETE]   at async resolveRootWatchMode (…dsh-skill-filesystem/lib/index.js:506:9)
   [skill-toggle][INCOMPLETE]   at async SkillWatchManager.openStableWatcher (…lib/index.js:334:17)
   [skill-toggle][INCOMPLETE]   at async SkillWatchManager.replaceWatcher (…lib/index.js:313:20)
   ```

2. **有界兜底重读**：`complete=false` 时**再读一次**；只有当第二次独立读取明确回报
   `complete === true` 才采用它。语义依据是 `dsh-skill` 自己的注释 —— "不完整观测不缓存，
   留给消费方在下一个请求边界重试"（`dsh-skill/lib/index.js:227-233`）；本插件只是把那次重试
   提前到本次读取里，让目录**当步**就能下发。
   **为什么不掩盖真问题**：插件**从不自己把 `complete` 改成真**，只转发一次真实读取的结论；
   provider 真坏了（watcher 起不来、provider 抛错）时两次都是假 ⇒ 结果照旧为假，观测点照旧落盘。
   重读只做一次，且重读抛错时保留第一次的结果。

### 上游那一侧：两处挂载行都关掉了 watcher（`watch: false`）

`dsh-skill-filesystem` 的 watcher 是路径 ① 的唯一来源。关掉它之后 `retainRoot()` 不再
`ensureWatcher()`（`if (this.config.enabled)` 直接跳过）⇒ ① 整条消失；同时宿主里"文件一变就
`invalidateCache()`"的频率大幅下降 ⇒ ③ 也几乎不可能。本机两处挂载行（profile 的
`skill-filesystem-host`、协调者预设的 `skill-filesystem`）都已加 `watch: false`。

**取舍（明确接受）**：技能目录的**实时热更新**失效 —— 外部（编辑器 / 资源管理器 / 脚本）改技能文件后，
目录要等下一次会话或重启才刷新；模型自己用 `write`/`edit` 改技能文件仍会经 `fs/observed` 立刻刷新
（那条路不依赖 watcher）。本机技能集合长期稳定，这个取舍可接受。回滚 = 删掉那两行 `watch: false`。

## 怎么装（三处装载入口，缺一不可）

1. **包内** `cordis.patch.yml`：本包自带的 patch 层，含 `- insert: - id: skill-toggle / name: 'dsh-skill-toggle'`。
   行 id `skill-toggle` 是插件页行级开关与 settings 命名空间的寻址键，**勿改**。
2. **包** `package.json`：`dsh.bundle.patch: ./cordis.patch.yml`，且 `files` 白名单含 `cordis.patch.yml`
   —— pnpm 的 `file:` 拷贝**只按 `files` 落文件**，漏了整包被静默跳过。
3. **profile** `package.json`：`dsh.profile.bundles` 里要有包名 `dsh-skill-toggle`。

本机**用工作区的 `dsh-plugin-manager`，不要用官方 `dsh plugin add`**（后者超时被中断时会漏写 `bundles`，
装了等于没装）：

```powershell
node <工作区>\dsh\dsh-plugin-manager\dshpm.mjs add link:<工作区>\dsh\dsh-skill-toggle --profile desktop
```

`link:` 是工作区源码直连 profile（本机既有的 `dsh-client-ui-session-rail` 就是这个形态）；用 `file:` 也可，
只是多一份运行副本要同步。**装完要重启一次 dsh**（`lib/*.js` 按 URL 缓存，热重载不重新 import）。

**浏览器半身的额外两处**（v0.3.0，只在要 UI 时才需要）：

4. **包** `package.json` 的 `dsh.client`：`{ "platform": "web", "inject": [...] }` —— 宿主扫到它才会把
   `lib/client.js` 当客户端模块发给浏览器。`inject` 只用来**排序**（先加载依赖再加载本插件），
   写错/写不存在的包名不会报错，只是不排序。
5. **包** `package.json` 的 `exports` 要有 `"./client": "./lib/client.js"`（模块表按这个子路径取包）。

两者齐了还**要重启一次 dsh**：客户端模块图是启动时按 Loader 条目扫描出来的，新声明的 `dsh.client`
不会热生效。

## 怎么用

**开关（日常入口）**：设置 → 技能开关，点一下即可（见上面「设置页 UI」）。

**改 JSON（权威入口）**：`%USERPROFILE%\.dsh\dsh-skill-toggle.json`

```json
{ "disabled": ["godot-use", "computer-control"] }
```

**或者用 CLI**（读-改-写，原子写：临时文件 + rename）：

```powershell
node <工作区>\dsh\dsh-skill-toggle\cli.mjs list
node <工作区>\dsh\dsh-skill-toggle\cli.mjs disable godot-use
node <工作区>\dsh\dsh-skill-toggle\cli.mjs enable  godot-use
```

CLI 路径优先级：`--state-file <路径>` > 环境变量 `DSH_SKILL_TOGGLE_STATE` > `$DSH_HOME\dsh-skill-toggle.json`。
**文件损坏时 CLI 与设置页都拒绝写入** —— 名单还在坏文件里，覆盖等于把它清空。

三条写路径的分工：**JSON = 权威**（手写整份名单）、**UI = 按名字改一个**、**CLI = 按名字改一个 + 可指定文件**。
UI 与 CLI 共用 `lib/index.js` 里的 `toggleDisabledName`（同一条"损坏拒绝写"纪律）；
唯一差别是文件**不存在**时的起点：UI 知道插件 config，从 `config.disabled` 起算，CLI 拿不到 config，从空名单起算。

插件 config（一般不用动，测试靠它隔离）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `stateFile` | `$DSH_HOME\dsh-skill-toggle.json` | 状态文件路径 |
| `disabled` | `[]` | **备用**注入点：只在状态文件不存在（或损坏）时生效，与文件**不相加** |
| `watchIntervalMs` | `500`（下限 20） | `fs.watchFile` 轮询间隔，只影响"变化即重算日志 + invalidate 广播"的灵敏度；过滤本身每次读取都现读文件，不依赖它 |
| `diagnose` | `true` | `complete=false` 时逐 provider 落盘成因（`[skill-toggle][INCOMPLETE]`，每实例每 10s 一行）；关掉只是少几行日志 |
| `repairIncomplete` | `true` | `complete=false` 时重读一次；**仅当重读明确 `complete=true` 才采用**（从不伪造 complete，见上文） |

## 生效时机（无需重启）

改名单 → **下一次读取**就是新名单（过滤发生在读取结果上，与注册表的合并缓存无关）。
`dsh-tool-skill` 的 `agent/pre-step` 钩子每个模型步骤都会 `snapshot()` 一次、按 digest 决定是否重发目录
（`lib/index.js:203-236`）⇒ 观感仍是"**下一个模型步骤**生效"，改 JSON 后不需要重启、也不需要重新建会话。

`fs.watchFile` 仍然保留（默认 500ms 轮询，`persistent:false`），但它现在是**保险**而不是生效前提：

- 状态文件一变就重算一行名单日志（落盘凭据）；
- 顺带调一次 `invalidateCache()`，让按 revision 缓存的外部消费者与 `skills/change` 监听者同步刷新。

已经渲染进会话的那条目录消息**不会当场消失**，它在下一次重算时被"替换目录"顶掉 —— 所以是
"下一个模型步骤"，不是"立刻"。

## 状态文件与优先级

| 状态文件 | 生效名单 | 说明 |
| --- | --- | --- |
| 存在且可读 | **完全以文件为准** | 手写 `{}` 或 `{"disabled":[]}` 都算空名单 |
| 不存在 | `config.disabled` | 插件 config 的备用注入点，默认空 |
| 损坏 | `config.disabled`（默认即"全部启用"） | 打一行警告，**绝不覆盖写坏文件** |

两者**不相加**：文件一旦存在，`config.disabled` 就不再参与 —— 否则会出现"文件里删了名字却依然禁用"。
损坏时选择 fail-open（技能照旧可用）：宁可漏禁，也不要因为一个坏文件让模型看不见任何技能。

## 影响面（包的是服务实例本身，写清楚）

包装落在**注册表实例**上，所以宿主里所有拿 `ctx.skills` 的消费者都受影响（本机实测三处）：

| 消费者 | 被禁技能的表现 |
| --- | --- |
| `dsh-tool-skill` 工具路径 | `list()` 里找不到 ⇒ 抛 `skill "X" is unknown or no longer available` |
| `dsh-tool-skill` 的 `/名字` 手势（`agent/pre-step`） | `get()` 返回 `undefined` ⇒ 跳过注入，手势**静默无效**（刻意：被禁技能对模型和用户都不可用） |
| `dsh-api-session-controller` 的会话技能列表 | 被禁技能从列表里消失 |

`ctx.skills.get(名字)` 的返回约定：**名单里的名字恒为 `undefined`**（v1 是"返回一段说明性正文"，
现在没有占位实现了）。依赖"拿不到正文也至少能拿到 summary"的消费者请自行处理 `undefined`。

边界情形：宿主正常只有一份 `skills` 服务实例（本机 web profile 实测三条路径都走它）。若某个 preset
自挂一份 `dsh-skill`（`agentPresets.serviceFor(agent, 'skills')` 这条 API 允许的形态），那份实例不在
`ctx.skills` 上 —— 插件会在 apply 与 `agent/created` 时检查每个活跃 agent 的技能视图，解析到**另一份**
实例就一并包装（正常情况下是同一个实例，属于空操作）。

## 落盘诊断日志

宿主 logger 只进内存 buffer、不落盘，所以关键节点都**同时写 stdout** —— 宿主 stdout/stderr 由 watchdog
收进 `<工具目录>\dsh-watchdog-dsh.log`（行前缀统一是 `[skill-toggle]`）：

| 日志行 | 含义 |
| --- | --- |
| `>>> APPLY 进入 <<< stateFile=… 状态=ok\|missing\|corrupt 名单=N 条 […] 不完整快照：诊断=开 兜底重读=开` | 插件真的进了运行树（这行不在 ⇒ 包没被加载）；末尾两个开关回显是"新版本已生效"的判据 |
| `机制就绪：技能注册表已包装，方法=[snapshot, list, get] …` | 包装成功（这行不在 ⇒ 包装失败，紧邻一行有原因） |
| `设置页状态接口已注册：/api/skill-toggle/state（GET 读快照 / POST {name,enabled} 改名单）` | 设置页能读到数据的前提；这行不在 ⇒ UI 会显示"宿主没挂上 …（HTTP 404）" |
| `状态接口未注册：connection 服务没有 fetch.register …` | 降级：`connection` 在、但它没有 `fetch` 注册表；**宿主过滤不受影响** |
| `[skill-toggle][INCOMPLETE] …` | **技能快照不完整**（`complete=false`）⇒ 这一步不下发目录；后面几行逐 provider 给出成因、出错根路径与抛错原文。持续出现就是"某条路径一直在坏"，只出现一次多半是 revision 竞态 |
| `状态文件变化 ⇒ 名单重算：状态=… 名单=N 条 […]` | 监听器看到文件变了（保险路径，不是生效前提） |
| `状态文件不可用（…）⇒ 本次按"全部启用"处理` | 损坏降级（fail-open） |
| `apply 抛错，插件已降级（禁用名单本次不生效）：…` | 兜底：apply 绝不把异常抛回 loader（本机教训：插件加载失败会让整个 dsh 起不来） |

## 已知限制

- **用户 `/名字` 手势也会被一起禁掉**。这是刻意的：三处一起摘才干净。
- **只按技能名精确匹配，不做通配/前缀/正则**。名字必须是合法 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）。
- 非法条目（大小写混用、下划线、数字）**被忽略并打一行警告**，同一份名单里的合法名字照常生效。
- 名单里的**陌生名字**现在完全无副作用（没有对应的真身可摘，也不会凭空多出一条"占位技能"）；
  "技能以后装了就已经被禁"这个语义仍然成立。
- 包装是**全局**的：见上面「影响面」。想让某个技能只对某类会话隐藏，本插件做不到。
- `agents` 服务拿不到时**不打日志**（只留一行 debug）：核心机制不需要它，那一节只是"preset 自挂注册表"
  的兜底。只有在真发现另一份实例、或 `agents.list()` 抛错/返回非数组时才落盘一行。

## 不做什么（边界）

- 不注册 provider、不注册模型工具、不新开端口、不出网、不做技能增删改。
- **只注册一条路由**：`/api/skill-toggle/state`（v0.3.0 为设置页 UI 加的）。它挂在共享 `/api` 通道上，
  因此自带浏览器信任栅栏与会话鉴权，不是公开路由；不注册任何 `ctx.webServer` 路由。
- 不 import 任何宿主包，只用 Node 标准库（见下面「落盘形态」里的实测原因）；客户端半身同理，
  只用浏览器模块表给的 `react`。
- 不改技能文件、不改 profile 任何文件、不写技能目录。

## 落盘形态

`link:`（Junction）与 `file:`（硬链接/拷贝）两种形态的判定、断链后果与处置，
**唯一权威副本**：`<工作区>\dsh\dsh-plugin-manager\README.md` 的「本地 `file:` 插件的落盘形态（全机机制，唯一权威副本）」一节。

对本包有两条**实测**结论：

- 本包在 profile 里是 `link:` ⇒ `node_modules\dsh-skill-toggle` 是指向工作区本目录的 **Junction**，
  两侧 `fsutil file queryfileid` 相同、`fsutil hardlink list` 各只有一条路径 —— 两侧本来就是同一个
  目录项，任何写法都同时落到两侧（不是"硬链接"，别按硬链接的断链逻辑理解）；
- Junction 形态下 Node 按 **realpath** 解析模块（探针实测 `import.meta.url` 落在源码目录），
  所以从源码目录**裸 import 宿主包会 `ERR_MODULE_NOT_FOUND`**。本包因此只 import `node:*` 与相对路径
  —— 两种落盘形态都能加载。

## 自测

```powershell
cd <工作区>\dsh\dsh-skill-toggle
node --test "test/*.test.mjs"
```

**60 个用例全绿**，分六个文件：

- `test/registry-wrap.test.mjs`（15 个）：机制本体用**假 registry** 测 —— 过滤规则、`complete` 保留、
  每次现读名单、幂等与引用计数还原、只包读路径、坏注册表不抛；**新增 4 条**钉住 v0.2.0 的两件事：
  `complete=false` 时重读一次（第二次为真则采用 / 持续为假则**原样透出**，绝不伪造）、观测点落盘
  （provider 名 + 出错根路径 + 抛错原文）、以及陌生注册表结构下观测点不抛；
- `test/registry-integration.test.mjs`（12 个）：**真实**注册表 + **真实** `dsh-skill-filesystem`
  （指向临时技能根）+ 真实状态文件 —— 核心用例（写名单 ⇒ `list()`/`snapshot()` 里消失 ⇒ 删掉后恢复）、
  `get()` 判死、Cordis traceable Proxy 上包装落到原实例、损坏 fail-open、非法名字、卸载还原、
  apply 两次不叠层、`complete` 透传；**新增 1 条**：一次瞬时的不完整观测被兜底重读救回（当步 `complete=true`）；
- `test/scope-layers.test.mjs`（3 个）：真身挂在 **preset 层**（比全局层更近）也照样摘掉、拿不到 `agents`
  服务也照样摘、卸载后真身回归 —— 钉住"机制与作用域层无关"；
- `test/state-file.test.mjs`（11 个）：状态文件三态、原子写、config 优先级、CLI；
- `test/ui-state.test.mjs`（10 个，v0.3.0）：**假 connection 服务**捕获插件注册进来的路由，直接调它的
  `fetch` —— 注册形状（路径/方法/请求体模式）、GET 含被禁技能的完整目录、POST 读-改-写与回读、
  非法名 400 / 损坏文件 409 且坏文件原样保留、请求体不合法 400、拿不到 `connection` 只降级不刷日志、
  **`connection` 晚到也照样注册上**（2026-09-28 那个 404 的回归用例）、卸载时路由随之摘掉；
  外加 `readFullCatalog` 绕过自身过滤、`toggleDisabledName` 的起点/排序/拒绝规则；
- `test/client-module.test.mjs`（9 个，v0.3.0）：浏览器半身离线测 —— 模块表契约与 id、**路由常量与
  宿主的 `STATE_ROUTE` 逐字对齐**、zh/en 文案键集一致、`apply` 的注册形状（座位/id/order/label/locale）、
  locale 或 slots 缺席时的降级、以及纯函数 `normalize` / `withToggled` / `withBusy` / `buildRows`。

**浏览器半身测不到渲染**：本机没有可 `require` 的 react 包（React 打进 web 前端产物，模块表只在浏览器里给），
所以用最小 React 桩让 factory 跑完、只钉"注册形状"，真正的渲染只能在页面里验收。

测试只写**临时目录**（`DSH_HOME` 也被指过去），**绝不碰**真实的 `~\.dsh\dsh-skill-toggle.json` 与
`~\.dsh\skills\`。宿主包从 dsh 安装树解析（`createRequire` 锚到 dsh 的 `package.json`），插件目录里
**没有 `node_modules`**。

做过**变异验证**（临时改坏 → 用例必须红 → 还原后 SHA256 一致）：拿掉 `snapshot` 的过滤 ⇒ 5 条红；
拿掉 `get` 的判死 ⇒ 6 条红；拿掉卸载还原 ⇒ 5 条红；`readFullCatalog` 不再绕过自身过滤 ⇒ 2 条红；
`toggleDisabledName` 去掉"损坏拒绝写" ⇒ 3 条红；把 `ctx.inject(['connection'])` 换回一次性
`ctx.get('connection')` ⇒ 1 条红（正是"connection 晚到"那条）。⇒ 用例有区分度。

## 活体验收（2026-09-28，重启后实测）

状态文件写 `{"disabled": ["readme-generator"]}`、重启宿主（新机制由 `>>> APPLY 进入 <<<` 与
`机制就绪：技能注册表已包装，方法=[snapshot, list, get]` 两行确认）后：

| 动作 | 实测结果 |
|---|---|
| `skill {"name":"readme-generator"}`（被禁） | `Error: skill "readme-generator" is unknown or no longer available` |
| `skill {"name":"ds-token-counter"}`（未禁） | 正常返回完整正文（工具本身没坏） |

⇒ v2 机制在活体上生效：被禁技能**无法被 `skill` 工具加载**。

⚠ **目录路径的活体结论仍待补**：宿主里另有一个**独立缺陷**会让技能目录整场不下发 ——
`dsh-skill-filesystem` 的 `observeRoots` 一旦抛错就返回 `complete:false`，而
`dsh-tool-skill` 见到 `!snapshot.complete` 就**不发布目录**。本会话自 2026-09-28T00:32Z 之后
再没重发过目录（重启多次也没发），所以"目录里是否已摘掉被禁技能"无法用活体判定，
只能靠单测与隔离进程的证据（`test/registry-integration.test.mjs` 用真实注册表 + 真实
`dsh-skill-filesystem` 跑出 `含 readme-generator=false`）。该缺陷的定位与修法属于另一条线
（本机验证记录未随包发布），与本插件机制无关。

**2026-09-28 下午的进展（本插件的 v0.2.0 侧）**：上面那条缺陷现在有两道防线 ——
上游两处挂载行都加了 `watch: false`（见上文「上游那一侧」），本插件加了落盘观测点
`[skill-toggle][INCOMPLETE]` 与有界兜底重读。**活体验收仍未做**（需要重启宿主）；
重启后要看的行与判据见上文「落盘诊断日志」表。

### 设置页 UI 活体验收（2026-09-29，重启后实测）

- **宿主接口层（自签 cookie 直连，不经页面）**：`GET /api/skill-toggle/state` 返回 200、列出 9 个技能；
  `POST` 拨一个开关 ⇒ 状态文件与技能目录**当场跟着变**；拨回即恢复。
- **设置页渲染（真机）**：暗色主题下技能列表 9 个、已关 0 个、无崩溃占位 —— UI 侧正常。
- **未验**：亮色主题与浏览器控制台。本机 Edge 未开调试端口，CUA 读不到 console，
  只能算“没有证据表明崩溃”。

## 坑

1. `node --test test/` 这种目录写法在本机别用，用 `node --test "test/*.test.mjs"`。
2. 安装后**运行副本**才是被加载的那份；本包是 Junction 形态，两侧同一份文件，判据见上面「落盘形态」。
3. 改 `lib/*.js` 一律要重启 dsh；改包内 `cordis.patch.yml` 不会热生效（hmr 只盯 profile 的
   `cordis.patch.yml`、`$DSH_HOME\cordis.patch.yml` 与 profile `package.json`）。
4. 卸载（`dshpm remove` 或插件页总开关）时本插件会把注册表上的包装方法**还原成原样**；
   不需要动任何技能文件。
5. 状态文件路径可用插件 config 的 `stateFile` 注入（测试就是这么隔离的）；`disabled` 是备用注入点，
   `watchIntervalMs` 只影响监听灵敏度，优先级见上表。
6. 包装的目标是**服务实例**：同一进程里如果还有第二份 `dsh-skill`（preset 自挂），那属于另一份实例，
   由「影响面」里说的 agent 视图检查兜底。

## 许可

MIT License —— 全文见仓库根目录的 [`LICENSE`](LICENSE)。

Copyright (c) 2026 liuyun847
