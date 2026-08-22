#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  createReadStream,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fnos', 'build-config.json'), 'utf8'))
const APP_PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const WSL_DISTRO = process.env.FNOS_WSL_DISTRO || 'Ubuntu-24.04'
const DEFAULT_STAGE = join(ROOT, 'build', 'fnos', 'staging', 'hermes-studio')

function parseArgs(argv) {
  const options = { stage: DEFAULT_STAGE, fpk: '' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--stage' && argv[index + 1]) options.stage = resolve(argv[++index])
    else if (argv[index] === '--fpk' && argv[index + 1]) options.fpk = resolve(argv[++index])
    else throw new Error(`未知参数：${argv[index]}`)
  }
  return options
}

function log(message) {
  console.log(`[fnOS verify] ${message}`)
}

function fail(message) {
  throw new Error(message)
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function wslArgs(args, cwd) {
  return ['-d', WSL_DISTRO, ...(cwd ? ['--cd', cwd] : []), '--', ...args]
}

function executeWsl(args, options = {}) {
  const { cwd, ...spawnOptions } = options
  return execute('wsl.exe', wslArgs(args, cwd), spawnOptions)
}

function captureWsl(args, options = {}) {
  const result = executeWsl(args, options)
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || `WSL 命令失败：${args.join(' ')}`).trim())
  }
  return result.stdout.trim()
}

function runWsl(args, options = {}) {
  const result = executeWsl(args, { ...options, stdio: 'inherit' })
  if (result.status !== 0) fail(`WSL 命令退出 ${result.status ?? 'unknown'}：${args[0]}`)
}

function toWslPath(path) {
  return captureWsl(['wslpath', '-a', resolve(path)])
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', resolveHash)
    stream.on('error', rejectHash)
  })
  return hash.digest('hex')
}

function parseManifest(path) {
  return Object.fromEntries(readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const index = line.indexOf('=')
      return [line.slice(0, index), line.slice(index + 1)]
    }))
}

function* walkFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkFiles(path)
    else if (entry.isFile() || entry.isSymbolicLink()) yield path
  }
}

function assertPng(path, width, height) {
  const data = readFileSync(path)
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(`${basename(path)} 不是 PNG`)
  if (data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) {
    fail(`${basename(path)} 必须是 ${width}x${height}`)
  }
}

function readMagic(path, length) {
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(path, 'r')
  try {
    return buffer.subarray(0, readSync(descriptor, buffer, 0, length, 0))
  } finally {
    closeSync(descriptor)
  }
}

async function verifyStage(stage) {
  const required = [
    'manifest',
    'ICON.PNG',
    'ICON_256.PNG',
    'config/privilege',
    'config/resource',
    'wizard/upgrade',
    'wizard/config',
    'wizard/uninstall',
    'cmd/main',
    'cmd/runtime-install',
    'cmd/uninstall_init',
    'cmd/uninstall_callback',
    'app/hermes-studio',
    'app/bin/hermes-studio-mcp.mjs',
    'app/package.json',
    'app/build-manifest.json',
    'app/dist/client/index.html',
    'app/dist/server/index.js',
    'app/dist/skills',
    'app/node_modules/node-pty/package.json',
    'app/node_modules/sharp/package.json',
    'app/node_modules/socket.io/package.json',
    `app/runtime/${CONFIG.hermesRuntime.packageName}`,
    `app/runtime/${CONFIG.hermesRuntime.packageName}.sha256`,
    'app/ui/images/icon_64.png',
    'app/ui/images/icon_256.png',
  ]
  for (const item of required) {
    if (!existsSync(join(stage, item))) fail(`完整包缺少：${item}`)
  }

  const bundledSkillFiles = [...walkFiles(join(stage, 'app', 'dist', 'skills'))]
    .filter(path => basename(path) === 'SKILL.md')
  if (bundledSkillFiles.length === 0) fail('FPK 未包含任何内置技能')

  const mainScript = readFileSync(join(stage, 'cmd', 'main'), 'utf8')
  if (/HERMES_WEB_UI_DISABLE_SKILL_INJECTION\s*=\s*1/.test(mainScript)) {
    fail('fnOS 启动脚本关闭了内置技能注入')
  }

  const manifest = parseManifest(join(stage, 'manifest'))
  if (manifest.appname !== 'hermes-studio') fail('FPK appname 错误')
  if (manifest.version !== APP_PACKAGE.version) fail('FPK 版本与源码不一致')
  if (manifest.platform !== 'x86') fail('fnOS manifest 必须使用 x86 平台标签')
  const privilege = JSON.parse(readFileSync(join(stage, 'config', 'privilege'), 'utf8'))
  if (privilege.defaults?.['run-as'] !== 'package') fail('应用未使用 package 用户运行')
  const resource = JSON.parse(readFileSync(join(stage, 'config', 'resource'), 'utf8'))
  const apiScope = resource?.['api-scope']
  if (!Array.isArray(apiScope)
    || apiScope.length !== 2
    || apiScope[0] !== 'trim.file.sharedAccess'
    || apiScope[1] !== 'trim.system.getPlatformConfig') {
    fail('fnOS 资源权限必须声明 trim.file.sharedAccess 与 trim.system.getPlatformConfig')
  }
  for (const name of ['upgrade', 'config', 'uninstall']) {
    const wizard = JSON.parse(readFileSync(join(stage, 'wizard', name), 'utf8'))
    const valid = Array.isArray(wizard)
      && wizard.length > 0
      && wizard.every(step => typeof step?.stepTitle === 'string' && Array.isArray(step.items) && step.items.length > 0)
    if (!valid) fail(`fnOS 向导不能为空且必须包含页面项目：wizard/${name}`)
  }
  const uninstallWizard = JSON.parse(readFileSync(join(stage, 'wizard', 'uninstall'), 'utf8'))
  const uninstallItems = uninstallWizard.flatMap(step => step.items)
  const dataAction = uninstallItems.find(item => item?.field === 'wizard_data_action')
  const dataActionValues = dataAction?.options?.map(option => option?.value) || []
  if (dataAction?.type !== 'radio' || dataAction.initValue !== 'keep'
    || !dataActionValues.includes('keep') || !dataActionValues.includes('delete')) {
    fail('卸载向导必须提供默认保留、可选删除的数据处理单选项')
  }

  assertPng(join(stage, 'ICON.PNG'), 64, 64)
  assertPng(join(stage, 'ICON_256.PNG'), 256, 256)
  assertPng(join(stage, 'app', 'ui', 'images', 'icon_64.png'), 64, 64)
  assertPng(join(stage, 'app', 'ui', 'images', 'icon_256.png'), 256, 256)

  const program = join(stage, 'app', 'hermes-studio')
  const programMagic = readFileSync(program).subarray(0, 4).toString('hex')
  if (programMagic !== '7f454c46') fail('hermes-studio 不是 Linux ELF')
  if (statSync(program).size < 50 * 1024 * 1024) fail('hermes-studio ELF 体积异常，SEA 可能未注入')

  const buildManifest = JSON.parse(readFileSync(join(stage, 'app', 'build-manifest.json'), 'utf8'))
  if (buildManifest.target?.os !== 'linux' || buildManifest.target?.arch !== 'x64') fail('构建目标不是 linux-x64')
  if (buildManifest.sea?.sha256 !== await sha256File(program)) fail('SEA ELF 哈希与构建清单不一致')

  const runtime = join(stage, 'app', 'runtime', CONFIG.hermesRuntime.packageName)
  if (statSync(runtime).size !== CONFIG.hermesRuntime.size) fail('Hermes Runtime 体积不正确')
  if (await sha256File(runtime) !== CONFIG.hermesRuntime.sha256) fail('Hermes Runtime SHA256 不正确')

  const sharp = JSON.parse(readFileSync(join(stage, 'app', 'node_modules', 'sharp', 'package.json'), 'utf8'))
  const nodePty = JSON.parse(readFileSync(join(stage, 'app', 'node_modules', 'node-pty', 'package.json'), 'utf8'))
  const socketIo = JSON.parse(readFileSync(join(stage, 'app', 'node_modules', 'socket.io', 'package.json'), 'utf8'))
  if (nodePty.version !== '1.1.0' || sharp.version !== '0.35.3' || socketIo.version !== '4.8.3') {
    fail('原生依赖版本不正确')
  }
  for (const packageName of ['sharp-linux-x64', 'sharp-libvips-linux-x64']) {
    if (!existsSync(join(stage, 'app', 'node_modules', '@img', packageName))) fail(`缺少 @img/${packageName}`)
  }

  const forbidden = /(^|[\\/])(electron|win32-(?:x64|ia32|arm64))([\\/]|$)|\.(?:exe|dll|msi|appx|bat|cmd|ps1)$/i
  for (const path of walkFiles(stage)) {
    const name = relative(stage, path).replaceAll('\\', '/')
    if (forbidden.test(name)) fail(`Linux FPK 混入 Windows/Electron 资产：${name}`)
    if (!lstatSync(path).isSymbolicLink()) {
      if (readMagic(path, 2).toString('ascii') === 'MZ') fail(`Linux FPK 混入 PE 二进制：${name}`)
    }
  }

  const index = readFileSync(join(stage, 'app', 'dist', 'client', 'index.html'), 'utf8')
  if (!index.includes('/app/hermes-studio/')) fail('前端资源不是 fnOS 子路径构建')
  if (/\b(?:src|href)=["']\/(?!app\/hermes-studio\/)/.test(index)) fail('前端首屏存在越过网关前缀的绝对资源')
  log('静态完整性、权限声明、ELF 与 Linux 原生依赖通过')
  return { program, runtime }
}

function assertElf(path, expectedLabel) {
  const description = captureWsl(['file', '-L', path])
  if (!description.includes('ELF 64-bit') || !description.includes('x86-64')) fail(`${expectedLabel} 不是 x86_64 ELF：${description}`)
  const header = captureWsl(['readelf', '-h', path])
  if (!/Machine:\s+Advanced Micro Devices X86-64/i.test(header)) fail(`${expectedLabel} ELF 架构错误`)
  const dependencies = captureWsl(['ldd', path])
  if (/not found/i.test(dependencies)) fail(`${expectedLabel} 有缺失动态库：\n${dependencies}`)
}

function curlUnix(socket, url, options = {}) {
  const statusMarker = '__FNOS_HTTP_STATUS__:'
  const args = ['curl', '--silent', '--show-error', '--unix-socket', socket]
  for (const header of options.headers || []) args.push('--header', header)
  if (options.method) args.push('--request', options.method)
  if (options.body !== undefined) args.push('--header', 'Content-Type: application/json', '--data', options.body)
  if (options.query) {
    args.push('--get')
    for (const [key, value] of Object.entries(options.query)) {
      args.push('--data-urlencode', `${key}=${value}`)
    }
  }
  args.push('--write-out', `${statusMarker}%{http_code}`, url)
  const output = captureWsl(args)
  const marker = output.lastIndexOf(statusMarker)
  if (marker < 0) fail(`curl 未返回状态码：${url}`)
  return { body: output.slice(0, marker), status: Number(output.slice(marker + statusMarker.length)) }
}

async function verifyLinuxRuntime(stage) {
  const work = `/tmp/hermes-studio-fnos-verify-${process.pid}`
  if (!work.startsWith('/tmp/hermes-studio-fnos-verify-')) fail('拒绝不安全的 WSL 验收目录')
  const sourceStage = toWslPath(stage)
  const stageWsl = `${work}/stage`
  const app = `${stageWsl}/app`
  const pkgVar = `${work}/var`
  const pkgTmp = `${work}/tmp`
  const pkgHome = `${work}/home`
  const socket = `${app}/hermes-studio.sock`
  const trimEnv = [
    'env',
    `TRIM_APPDEST=${app}`,
    `TRIM_PKGVAR=${pkgVar}`,
    `TRIM_PKGTMP=${pkgTmp}`,
    `TRIM_PKGHOME=${pkgHome}`,
    `TRIM_TEMP_LOGFILE=${work}/install.log`,
    'HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT=1',
  ]
  let started = false
  try {
    runWsl(['rm', '-rf', work])
    runWsl(['mkdir', '-p', pkgTmp, pkgHome])
    runWsl(['cp', '-a', sourceStage, stageWsl])
    runWsl(['find', `${stageWsl}/cmd`, '-type', 'f', '-exec', 'chmod', '0755', '{}', '+'])
    runWsl(['chmod', '0755', `${app}/hermes-studio`])
    runWsl(['sh', '-n', `${stageWsl}/cmd/main`])
    runWsl(['sh', '-n', `${stageWsl}/cmd/runtime-install`])
    runWsl(['sh', '-n', `${stageWsl}/cmd/uninstall_init`])
    runWsl(['sh', '-n', `${stageWsl}/cmd/uninstall_callback`])
    assertElf(`${app}/hermes-studio`, 'Hermes Studio SEA')

    log('模拟 fnOS 安装回调并解压内置 Hermes Runtime')
    runWsl([...trimEnv, 'sh', `${stageWsl}/cmd/runtime-install`])
    const runtime = `${pkgVar}/runtime`
    const python = `${runtime}/python/venv/bin/python3`
    const hermes = `${runtime}/python/venv/bin/hermes`
    const node = `${runtime}/node/bin/node`
    for (const path of [python, hermes, node, `${runtime}/runtime-manifest.json`]) {
      const result = executeWsl(['test', '-e', path])
      if (result.status !== 0) fail(`解压后的 Runtime 缺少：${path}`)
    }
    assertElf(python, 'Bundled Python')
    assertElf(node, 'Bundled Hermes Node')

    const runtimeManifest = JSON.parse(captureWsl(['cat', `${runtime}/runtime-manifest.json`]))
    if (runtimeManifest.hermesAgentVersion !== CONFIG.hermesRuntime.version) fail('Runtime Hermes 版本错误')
    if (runtimeManifest.hermesSource?.commit !== CONFIG.hermesRuntime.sourceCommit) fail('Runtime Hermes 源码提交错误')
    const hermesVersion = captureWsl([hermes, '--version'])
    if (!hermesVersion.includes(CONFIG.hermesRuntime.version)) fail(`Hermes CLI 版本异常：${hermesVersion}`)
    runWsl([
      python,
      '-c',
      `import importlib.metadata as m, hermes_cli; assert m.version('hermes-agent') == '${CONFIG.hermesRuntime.version}'; print('[fnOS verify] Hermes Python import OK')`,
    ])
    runWsl([
      node,
      '-e',
      "const s=require('sharp');s({create:{width:3,height:2,channels:4,background:'#204060'}}).png().toBuffer().then(b=>{if(!b.length)process.exit(2);console.log('[fnOS verify] Sharp '+s.versions.sharp+' OK')}).catch(e=>{console.error(e);process.exit(1)})",
    ], { cwd: app })
    runWsl([
      node,
      '-e',
      "const p=require('node-pty');const x=p.spawn('/bin/sh',['-lc','printf terminal-ok'],{name:'xterm-color',cols:80,rows:24,cwd:process.cwd()});let out='';x.onData(d=>out+=d);x.onExit(e=>{if(e.exitCode!==0||!out.includes('terminal-ok'))process.exit(1);console.log('[fnOS verify] node-pty OK')})",
    ], { cwd: app })
    runWsl([node, `${app}/bin/hermes-studio-mcp.mjs`, '--version'], { cwd: app })

    log('通过生命周期脚本启动完整 Unix Socket 服务')
    const start = executeWsl([...trimEnv, 'sh', `${stageWsl}/cmd/main`, 'start'], { stdio: 'inherit' })
    if (start.status !== 0) {
      const serviceLog = executeWsl(['tail', '-n', '120', `${pkgVar}/logs/hermes-studio.log`])
      console.error(serviceLog.stdout || serviceLog.stderr || '')
      fail('cmd/main start 失败')
    }
    started = true

    const base = 'http://localhost/app/hermes-studio'
    let adminHealth
    let healthError
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        adminHealth = curlUnix(socket, `${base}/health`, { headers: ['X-Trim-Isadmin: true', 'X-Trim-Username: fnos-verify'] })
        healthError = undefined
      } catch (error) {
        healthError = error
      }
      if (adminHealth?.status === 200) break
      runWsl(['sleep', '1'])
    }
    if (healthError) throw healthError
    if (adminHealth?.status !== 200) fail(`管理员健康检查失败：${adminHealth?.status}`)

    const denied = curlUnix(socket, `${base}/health`)
    if (denied.status !== 403) fail(`缺少 fnOS 管理员身份时应返回 403，实际 ${denied.status}`)
    const headers = ['X-Trim-Isadmin: true', 'X-Trim-Username: fnos-verify']
    const session = curlUnix(socket, `${base}/api/auth/fnos-session`, { method: 'POST', body: '{}', headers })
    if (session.status !== 200) fail(`fnOS 管理员会话建立失败：${session.status} ${session.body}`)
    const token = JSON.parse(session.body).token
    if (typeof token !== 'string' || token.split('.').length !== 3) fail('fnOS 会话未返回 Studio JWT')

    const update = curlUnix(socket, `${base}/api/hermes/update`, { headers })
    if (update.status !== 404) fail(`fnOS 更新接口未被关闭：${update.status}`)
    const fnosRuntime = curlUnix(socket, `${base}/api/hermes/fnos-runtime`, {
      headers: [...headers, `Authorization: Bearer ${token}`],
    })
    if (fnosRuntime.status !== 200) fail(`fnOS Runtime 状态接口失败：${fnosRuntime.status} ${fnosRuntime.body}`)
    const fnosRuntimeStatus = JSON.parse(fnosRuntime.body)
    if (fnosRuntimeStatus.currentVersion !== CONFIG.hermesRuntime.version) {
      fail(`fnOS Runtime 当前版本异常：${fnosRuntimeStatus.currentVersion}`)
    }
    const localStt = curlUnix(socket, `${base}/api/hermes/stt/settings/active`, {
      method: 'PUT',
      body: '{"provider":"local"}',
      headers: [...headers, `Authorization: Bearer ${token}`],
    })
    if (![200, 409].includes(localStt.status)) {
      fail(`fnOS 本地 STT 接口不可用：${localStt.status} ${localStt.body}`)
    }

    const socketIo = curlUnix(socket, `${base}/socket.io/`, {
      headers,
      query: { EIO: '4', transport: 'polling' },
    })
    if (socketIo.status !== 200 || !socketIo.body.startsWith('0{')) fail(`Socket.IO polling 失败：${socketIo.status}`)
    const index = curlUnix(socket, `${base}/`, { headers })
    if (index.status !== 200 || !index.body.includes('/app/hermes-studio/')) fail('网关首屏加载失败')
    const mcpConfigPath = `${pkgVar}/hermes/config.yaml`
    const mcpConfig = captureWsl(['cat', mcpConfigPath])
    const mcpLauncher = `${app}/bin/hermes-studio-mcp.mjs`
    if ((mcpConfig.split(mcpLauncher).length - 1) < 4) fail('fnOS MCP 配置未为四个工具集写入内置启动器')
    if (mcpConfig.includes('command: hermes-studio-mcp') || mcpConfig.includes('127.0.0.1:0')) {
      fail('fnOS MCP 配置仍使用不可启动的裸命令或端口 0')
    }
    log('Unix Socket、管理员拒绝/允许、功能禁用与 Socket.IO 通过')

    if (started) {
      executeWsl([...trimEnv, 'sh', `${stageWsl}/cmd/main`, 'stop'], { stdio: 'inherit' })
      started = false
    }
    const uninstallScript = `${stageWsl}/cmd/uninstall_callback`
    runWsl(['mkdir', '-p', `${pkgVar}/uninstall-probe`])
    const keepUninstall = executeWsl([...trimEnv, 'wizard_data_action=keep', 'sh', uninstallScript])
    if (keepUninstall.status !== 0) fail('卸载保留数据分支失败')
    if (executeWsl(['test', '-d', `${pkgVar}/uninstall-probe`]).status !== 0) {
      fail('卸载保留数据分支误删了应用数据')
    }
    const deleteUninstall = executeWsl([...trimEnv, 'wizard_data_action=delete', 'sh', uninstallScript])
    if (deleteUninstall.status !== 0) fail('卸载删除数据分支失败')
    if (executeWsl(['test', '-e', pkgVar]).status === 0) fail('卸载删除数据分支未清理应用数据目录')
    log('卸载向导保留/删除应用数据分支通过')
  } catch (error) {
    const serviceLog = executeWsl(['tail', '-n', '200', `${pkgVar}/logs/hermes-studio.log`])
    console.error(serviceLog.stdout || serviceLog.stderr || '[fnOS verify] 服务日志不可用')
    throw error
  } finally {
    if (started) executeWsl([...trimEnv, 'sh', `${stageWsl}/cmd/main`, 'stop'], { stdio: 'inherit' })
    executeWsl(['rm', '-f', socket])
    executeWsl(['rm', '-rf', work])
  }
}

function listArchive(fpkWsl) {
  const tar = executeWsl(['tar', '--ignore-zeros', '-tf', fpkWsl])
  if (tar.status === 0) return { kind: 'tar', entries: tar.stdout.split(/\r?\n/).filter(Boolean) }
  const unzip = executeWsl(['unzip', '-Z1', fpkWsl])
  if (unzip.status === 0) return { kind: 'zip', entries: unzip.stdout.split(/\r?\n/).filter(Boolean) }
  fail(`无法反向读取 FPK：${tar.stderr || unzip.stderr || '未知格式'}`)
}

function findWslFiles(root, name) {
  const output = captureWsl(['find', root, '-type', 'f', '-name', name, '-print'])
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

async function verifyFpk(fpk, stage) {
  if (!existsSync(fpk)) fail(`FPK 不存在：${fpk}`)
  if (statSync(fpk).size < CONFIG.hermesRuntime.size) fail('FPK 体积小于内置 Runtime，疑似空壳')
  const fpkWsl = toWslPath(fpk)
  const description = captureWsl(['file', fpkWsl])
  const archive = listArchive(fpkWsl)
  if (!archive.entries.some(entry => /(^|\/)manifest$/.test(entry))) fail('FPK 内未找到 manifest')
  if (!archive.entries.some(entry => /(^|\/)ICON\.PNG$/.test(entry))) fail('FPK 内未找到 ICON.PNG')

  const work = `/tmp/hermes-studio-fpk-reverse-${process.pid}`
  if (!work.startsWith('/tmp/hermes-studio-fpk-reverse-')) fail('拒绝不安全的 FPK 解包目录')
  try {
    runWsl(['rm', '-rf', work])
    runWsl(['mkdir', '-p', work])
    if (archive.kind === 'tar') runWsl(['tar', '--ignore-zeros', '-xf', fpkWsl, '-C', work])
    else runWsl(['unzip', '-q', fpkWsl, '-d', work])

    if (archive.kind === 'tar') {
      for (const relativePath of ['cmd/main', 'cmd/runtime-install']) {
        const executable = executeWsl(['test', '-x', `${work}/${relativePath}`])
        if (executable.status !== 0) fail(`FPK 生命周期脚本缺失执行权限：${relativePath}`)
      }
    }

    let programs = findWslFiles(work, 'hermes-studio')
    let runtimes = findWslFiles(work, CONFIG.hermesRuntime.packageName)
    if (programs.length === 0 || runtimes.length === 0) {
      const nested = [
        ...findWslFiles(work, '*.tgz'),
        ...findWslFiles(work, '*.tar.gz'),
      ]
      for (let index = 0; index < nested.length; index += 1) {
        const nestedDir = `${work}/nested-${index}`
        const probe = executeWsl(['tar', '-tf', nested[index]])
        if (probe.status !== 0) continue
        runWsl(['mkdir', '-p', nestedDir])
        runWsl(['tar', '-xf', nested[index], '-C', nestedDir])
      }
      programs = findWslFiles(work, 'hermes-studio')
      runtimes = findWslFiles(work, CONFIG.hermesRuntime.packageName)
    }
    if (programs.length !== 1) fail(`FPK 反向解包后的主程序数量异常：${programs.length}`)
    if (runtimes.length !== 1) fail(`FPK 反向解包后的 Runtime 数量异常：${runtimes.length}`)

    const expectedProgramHash = await sha256File(join(stage, 'app', 'hermes-studio'))
    const expectedRuntimeHash = CONFIG.hermesRuntime.sha256
    const actualProgramHash = captureWsl(['sha256sum', programs[0]]).split(/\s+/)[0]
    const actualRuntimeHash = captureWsl(['sha256sum', runtimes[0]]).split(/\s+/)[0]
    if (actualProgramHash !== expectedProgramHash) fail('FPK 内 ELF 与 staging 哈希不一致')
    if (actualRuntimeHash !== expectedRuntimeHash) fail('FPK 内 Hermes Runtime 哈希不一致')
    assertElf(programs[0], 'FPK 内 Hermes Studio SEA')
    log(`FPK 反向解包通过：${description}`)
  } finally {
    runWsl(['rm', '-rf', work])
  }
}

async function main() {
  const { stage, fpk } = parseArgs(process.argv.slice(2))
  if (!existsSync(stage)) fail(`staging 不存在：${stage}`)
  await verifyStage(stage)
  await verifyLinuxRuntime(stage)
  if (fpk) await verifyFpk(fpk, stage)
  log('全部验收通过')
}

main().catch(error => {
  console.error(`[fnOS verify] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
