/**
 * 单元测试：状态文件的读/写规则、config 优先级、CLI。
 * 全部在临时目录里跑（`DSH_HOME` 也指到临时目录），不碰真实 `~\.dsh\dsh-skill-toggle.json`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultStateFile, readStateFile, resolveConfig, writeStateFile, STATE_FILE_NAME } from '../lib/index.js'
import { run as runCli } from '../cli.mjs'

/** 造一个临时工作目录。 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggle-unit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 临时改环境变量（用完还原）。 */
function withEnv(name, value, body) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('readStateFile：不存在 = 空名单（不是错误）', async (t) => {
  const dir = await tempDir(t)
  const state = readStateFile(join(dir, 'nope.json'))
  assert.equal(state.status, 'missing')
  assert.deepEqual(state.names, [])
  assert.deepEqual(state.dropped, [])
})

test('readStateFile：合法文件 / 空对象 / 空数组都算"可读"', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')

  await writeFile(file, `${JSON.stringify({ disabled: ['alpha-skill'] })}\n`, 'utf8')
  assert.deepEqual(readStateFile(file), { status: 'ok', names: ['alpha-skill'], dropped: [] })

  await writeFile(file, '{}\n', 'utf8')
  assert.deepEqual(readStateFile(file), { status: 'ok', names: [], dropped: [] })

  await writeFile(file, '{"disabled": []}\n', 'utf8')
  assert.deepEqual(readStateFile(file), { status: 'ok', names: [], dropped: [] })
})

test('readStateFile：去重、滤掉非法条目（非法条目进 dropped，不打断合法名单）', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')
  await writeFile(file, `${JSON.stringify({ disabled: ['alpha-skill', 'alpha-skill', 'Foo Bar', 42, null, 'beta_skill'] })}\n`, 'utf8')
  const state = readStateFile(file)
  assert.equal(state.status, 'ok')
  assert.deepEqual(state.names, ['alpha-skill'])
  assert.deepEqual(state.dropped, ['Foo Bar', 42, null, 'beta_skill'])
})

test('readStateFile：损坏形态一律报 corrupt（顶层数组 / disabled 非数组 / 坏 JSON / 顶层非对象）', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')
  for (const [label, content] of [
    ['坏 JSON', '{ "disabled": [' ],
    ['顶层是数组', '[]' ],
    ['顶层是字符串', '"nope"'],
    ['disabled 不是数组', '{"disabled": "alpha-skill"}'],
  ]) {
    await writeFile(file, content, 'utf8')
    const state = readStateFile(file)
    assert.equal(state.status, 'corrupt', `${label} 应当报 corrupt`)
    assert.deepEqual(state.names, [], `${label} 时名单为空（按全部启用处理）`)
    assert.equal(typeof state.detail, 'string')
  }
})

test('writeStateFile：原子写、可往返、UTF-8 无 BOM、不留临时文件', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'nested', 'state.json') // 父目录不存在，应当自动建
  const written = writeStateFile(file, ['beta-skill', 'alpha-skill', 'beta-skill'])
  assert.deepEqual(written, ['beta-skill', 'alpha-skill'], '保序去重')

  const raw = await readFile(file, 'utf8')
  assert.equal(raw.charCodeAt(0) === 0xFEFF, false, '不许有 BOM')
  assert.deepEqual(JSON.parse(raw), { disabled: ['beta-skill', 'alpha-skill'] })
  assert.deepEqual(readStateFile(file).names, ['beta-skill', 'alpha-skill'])

  assert.deepEqual(await readdir(join(dir, 'nested')), ['state.json'], '临时文件必须已经改名走掉')

  // 覆盖写：不追加、不留残渣
  writeStateFile(file, ['alpha-skill'])
  assert.deepEqual(readStateFile(file).names, ['alpha-skill'])
  assert.deepEqual(await readdir(join(dir, 'nested')), ['state.json'])
})

test('writeStateFile：非法技能名抛错（不静默丢弃）', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')
  assert.throws(() => writeStateFile(file, ['Foo Bar']), /非法技能名/)
  assert.throws(() => writeStateFile(file, ['alpha-skill', 42]), /非法技能名/)
  assert.equal(existsSync(file), false, '抛错时不该留下半个文件')
})

test('defaultStateFile：默认落在 $DSH_HOME 下，未设时为 ~\\.dsh\\dsh-skill-toggle.json', async () => {
  // 未设 DSH_HOME 时默认落在 homedir() 下 ⇒ 即 %USERPROFILE%\.dsh\dsh-skill-toggle.json
  const expected = join(homedir(), '.dsh', STATE_FILE_NAME)
  const actual = withEnv('DSH_HOME', undefined, () => defaultStateFile())
  assert.equal(actual, expected, '默认路径必须是 <home>\\.dsh\\dsh-skill-toggle.json')
  assert.equal(withEnv('DSH_HOME', 'D:\\tmp\\dsh-home', () => defaultStateFile()), join('D:\\tmp\\dsh-home', STATE_FILE_NAME))
})

test('resolveConfig：stateFile / disabled / watchIntervalMs 的默认与下限', async (t) => {
  const dir = await tempDir(t)
  const defaults = withEnv('DSH_HOME', dir, () => resolveConfig(undefined))
  assert.equal(defaults.stateFile, join(dir, STATE_FILE_NAME))
  assert.deepEqual(defaults.fallbackDisabled, [])
  assert.equal(defaults.watchIntervalMs, 500)

  const custom = resolveConfig({ stateFile: join(dir, 'x.json'), disabled: ['alpha-skill', 'nope nope'], watchIntervalMs: 5 })
  assert.equal(custom.stateFile, join(dir, 'x.json'))
  assert.deepEqual(custom.fallbackDisabled, ['alpha-skill'])
  assert.deepEqual(custom.fallbackDropped, ['nope nope'])
  assert.equal(custom.watchIntervalMs, 500, '低于下限的间隔回落到默认值')

  assert.equal(resolveConfig({ disabled: 'alpha-skill' }).fallbackDisabled.length, 0, '非数组的 disabled 一律忽略')
})

test('CLI：list / disable / enable 直接改状态文件并打印改后名单', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')
  const lines = []
  const io = { env: {}, out: (line) => lines.push(line), err: (line) => lines.push(`ERR ${line}`) }

  assert.equal(runCli(['list', '--state-file', file], io), 0)
  assert.ok(lines.some((line) => line.includes('不存在')), '文件不存在时应当说清"当前按全部启用处理"')

  lines.length = 0
  assert.equal(runCli(['disable', 'beta-skill', '--state-file', file], io), 0)
  assert.deepEqual(readStateFile(file).names, ['beta-skill'])
  assert.ok(lines.some((line) => line.includes('已禁用：beta-skill')))

  lines.length = 0
  assert.equal(runCli(['disable', 'alpha-skill', `--state-file=${file}`], io), 0)
  assert.deepEqual(readStateFile(file).names, ['alpha-skill', 'beta-skill'], '名单按名字排序')
  assert.ok(lines.some((line) => line.includes('禁用名单（2）：alpha-skill, beta-skill')))

  lines.length = 0
  assert.equal(runCli(['enable', 'alpha-skill', '--state-file', file], io), 0)
  assert.deepEqual(readStateFile(file).names, ['beta-skill'])
  assert.ok(lines.some((line) => line.includes('已恢复：alpha-skill')))

  lines.length = 0
  assert.equal(runCli(['enable', 'ghost-skill', '--state-file', file], io), 0)
  assert.ok(lines.some((line) => line.includes('无需改动：ghost-skill')))

  lines.length = 0
  assert.equal(runCli(['bogus', '--state-file', file], io), 2)
  assert.ok(lines.some((line) => line.startsWith('ERR 未知命令')))

  lines.length = 0
  assert.equal(runCli(['disable', 'Foo Bar', '--state-file', file], io), 1)
  assert.ok(lines.some((line) => line.startsWith('ERR 非法技能名')), '非法名字必须报错而不是写进去')
  assert.deepEqual(readStateFile(file).names, ['beta-skill'], '被拒绝时状态文件一个字都不能动')
})

test('CLI：文件损坏时拒绝写入（绝不覆盖坏文件）', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'state.json')
  const broken = '{ "disabled": ["alpha-skill"'
  await writeFile(file, broken, 'utf8')
  const lines = []
  const io = { env: {}, out: (line) => lines.push(line), err: (line) => lines.push(`ERR ${line}`) }

  assert.equal(runCli(['disable', 'beta-skill', '--state-file', file], io), 1)
  assert.ok(lines.some((line) => line.startsWith('ERR 状态文件损坏，拒绝写入')))
  assert.equal(await readFile(file, 'utf8'), broken, '坏文件必须原样保留')
  assert.equal(readStateFile(file).status, 'corrupt')
})

test('CLI：状态文件路径可用环境变量 DSH_SKILL_TOGGLE_STATE 指定', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'from-env.json')
  const lines = []
  assert.equal(runCli(['disable', 'alpha-skill'], { env: { DSH_SKILL_TOGGLE_STATE: file }, out: (l) => lines.push(l), err: (l) => lines.push(l) }), 0)
  assert.deepEqual(readStateFile(file).names, ['alpha-skill'])
})
