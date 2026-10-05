#!/usr/bin/env node
/**
 * dsh-skill-toggle 的极简 CLI —— 只改状态文件，不碰 dsh 进程、不碰技能文件。
 *
 * 用法（`<包目录>` = 本包所在目录，本机开发期是
 * `<工作区>\dsh\dsh-skill-toggle`）：
 *
 *   node <包目录>\cli.mjs list
 *   node <包目录>\cli.mjs disable <技能名>
 *   node <包目录>\cli.mjs enable  <技能名>
 *   node <包目录>\cli.mjs list --state-file D:\tmp\state.json
 *
 * 路径优先级：`--state-file <路径>` > 环境变量 `DSH_SKILL_TOGGLE_STATE` > `$DSH_HOME\dsh-skill-toggle.json`
 * （`DSH_HOME` 未设时即 `~\.dsh\dsh-skill-toggle.json`）。写盘是原子的（临时文件 + rename）。
 *
 * 纪律：**文件损坏时拒绝写入**（退出码 1）—— 名单还在坏文件里，覆盖等于把它清空；
 * 想从零开始就自己把坏文件改名或删掉。
 */
import { pathToFileURL } from 'node:url'
import { readStateFile, toggleDisabledName, defaultStateFile } from './lib/index.js'

/** 打印用法。 */
function usage() {
  return [
    '用法：node cli.mjs <命令> [参数] [--state-file <路径>]',
    '  list              打印当前禁用名单',
    '  disable <技能名>   把技能名加入禁用名单',
    '  enable  <技能名>   把技能名移出禁用名单',
    '',
    '技能名只接受小写 kebab-case（如 my-skill）。改完名单在 dsh 里**下一个模型步骤**生效，无需重启。',
  ].join('\n')
}

/** 解析 `--state-file <路径>` / `--state-file=<路径>`，其余 token 按原顺序返回。 */
function parseArgs(argv) {
  const rest = []
  let stateFile
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--state-file') {
      stateFile = argv[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--state-file=')) {
      stateFile = token.slice('--state-file='.length)
      continue
    }
    rest.push(token)
  }
  return { rest, stateFile }
}

/**
 * CLI 主体（导出供测试直接调用，不必 spawn 进程）。
 *
 * @param {string[]} argv 去掉 `node` 与脚本路径后的参数。
 * @param {{ env?: Record<string, string|undefined>, out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {number} 退出码。
 */
export function run(argv, io = {}) {
  const env = io.env ?? process.env
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  const { rest, stateFile: explicit } = parseArgs(argv)
  const stateFile = explicit
    ?? (typeof env.DSH_SKILL_TOGGLE_STATE === 'string' && env.DSH_SKILL_TOGGLE_STATE.length > 0 ? env.DSH_SKILL_TOGGLE_STATE : undefined)
    ?? defaultStateFile()

  const command = rest[0]
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out(usage())
    return command === undefined ? 2 : 0
  }
  if (command !== 'list' && command !== 'disable' && command !== 'enable') {
    err(`未知命令 ${JSON.stringify(command)}\n${usage()}`)
    return 2
  }

  const state = readStateFile(stateFile)
  if (command === 'list') {
    out(`状态文件：${stateFile}`)
    out(`文件状态：${state.status === 'ok' ? '可读' : state.status === 'missing' ? '不存在（当前按"全部启用"处理）' : `损坏（按"全部启用"处理）：${state.detail}`}`)
    out(`禁用名单（${state.names.length}）：${state.names.length > 0 ? state.names.join(', ') : '（空）'}`)
    if (state.dropped.length > 0) out(`已忽略的非法条目：${JSON.stringify(state.dropped)}`)
    return 0
  }

  const skillName = rest[1]
  if (skillName === undefined) {
    err(`${command} 需要一个技能名\n${usage()}`)
    return 2
  }

  const before = state.names
  // 写路径与设置页 UI 共用 lib 里的 toggleDisabledName（同一份"损坏拒绝写"纪律）。
  // CLI 拿不到插件 config，所以备用名单传空数组；UI 那条路会传 config.disabled。
  let result
  try {
    result = toggleDisabledName(stateFile, [], skillName, command === 'enable')
  } catch (error) {
    err(`写入失败：${error?.message ?? String(error)}`)
    return 1
  }
  if (!result.ok) {
    err(`${result.reason}\n状态文件：${stateFile}\n请先修好它，或把它改名/删除后重试。`)
    return 1
  }
  const after = result.disabled
  const changed = command === 'disable' ? !before.includes(skillName) : before.includes(skillName)
  out(`${changed ? (command === 'disable' ? '已禁用' : '已恢复') : '无需改动'}：${skillName}`)
  out(`状态文件：${stateFile}`)
  out(`禁用名单（${after.length}）：${after.length > 0 ? after.join(', ') : '（空）'}`)
  return 0
}

// 直接 `node cli.mjs ...` 时才执行（被 import 时只导出 run）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2))
}
