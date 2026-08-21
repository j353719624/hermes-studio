#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_ROOT = join(ROOT, 'build', 'fnos')
const CACHE_DIR = join(BUILD_ROOT, 'cache')
const NATIVE_DIR = join(BUILD_ROOT, 'native-linux-x64')
const STAGE_DIR = join(BUILD_ROOT, 'staging', 'hermes-studio')
const OUTPUT_DIR = join(BUILD_ROOT, 'output')
const TEMPLATE_DIR = join(ROOT, 'fnos', 'hermes-studio')
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fnos', 'build-config.json'), 'utf8'))
const APP_PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const WSL_DISTRO = process.env.FNOS_WSL_DISTRO || 'Ubuntu-24.04'
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function log(message) {
  console.log(`[fnOS] ${message}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim())
  }
  return result.stdout.trim()
}

function wslArgs(args, cwd) {
  return ['-d', WSL_DISTRO, ...(cwd ? ['--cd', cwd] : []), '--', ...args]
}

function runWsl(args, options = {}) {
  const { cwd, ...spawnOptions } = options
  run('wsl.exe', wslArgs(args, cwd), spawnOptions)
}

function captureWsl(args, options = {}) {
  const { cwd, ...spawnOptions } = options
  return capture('wsl.exe', wslArgs(args, cwd), spawnOptions)
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

async function assertHash(path, expected, expectedSize) {
  if (!existsSync(path)) return false
  if (expectedSize && statSync(path).size !== expectedSize) return false
  return await sha256File(path) === expected.toLowerCase()
}

async function downloadPinned(spec) {
  const destination = join(CACHE_DIR, spec.archive)
  if (await assertHash(destination, spec.sha256, spec.size)) {
    log(`使用已校验缓存：${spec.archive}`)
    return destination
  }

  const partial = `${destination}.part`
  rmSync(partial, { force: true })
  rmSync(destination, { force: true })
  log(`下载固定资源：${spec.url}`)
  const response = await fetch(spec.url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：${response.status} ${response.statusText} (${spec.url})`)
  }

  const total = Number(response.headers.get('content-length') || spec.size || 0)
  let received = 0
  let nextReport = 10
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (total > 0) {
        const percent = Math.floor(received * 100 / total)
        if (percent >= nextReport) {
          log(`${spec.archive}：${percent}%`)
          nextReport += 10
        }
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial))
  if (!await assertHash(partial, spec.sha256, spec.size)) {
    rmSync(partial, { force: true })
    throw new Error(`${spec.archive} 的大小或 SHA256 不匹配`)
  }
  renameSync(partial, destination)
  return destination
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

function validateTemplate() {
  const manifest = parseManifest(join(TEMPLATE_DIR, 'manifest'))
  if (manifest.appname !== 'hermes-studio') throw new Error('fnOS appname 必须为 hermes-studio')
  if (manifest.version !== APP_PACKAGE.version) throw new Error('manifest 与 package.json 版本不一致')
  if (manifest.platform !== CONFIG.target.fnosPlatform) throw new Error('manifest 平台与锁定目标不一致')
  for (const required of ['app', 'cmd', 'config', 'wizard']) {
    if (!existsSync(join(TEMPLATE_DIR, required))) throw new Error(`fnOS 模板缺少 ${required}`)
  }
}

function validateBundledBrowserRuntime(runtimeArchive) {
  const required = [
    './python/node/bin/agent-browser',
    './python/node/lib/node_modules/agent-browser/bin/agent-browser-linux-x64',
  ]
  for (const entry of required) {
    try {
      captureWsl(['tar', '-tzf', toWslPath(runtimeArchive), entry])
    } catch {
      throw new Error(`Hermes Runtime 缺少 fnOS 本机浏览器文件：${entry}`)
    }
  }
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find(candidate => existsSync(candidate))
  if (!npmCli) throw new Error('找不到 npm-cli.js，无法构建前端')
  return npmCli
}

function buildWebUi() {
  log('构建 /app/hermes-studio 子路径 WebUI 与 Server')
  run(process.execPath, [resolveNpmCli(), 'run', 'build'], {
    env: {
      ...process.env,
      HERMES_WEB_UI_BASE_PATH: '/app/hermes-studio',
      VITE_HERMES_FNOS_MODE: '1',
    },
  })
  const index = readFileSync(join(ROOT, 'dist', 'client', 'index.html'), 'utf8')
  if (!index.includes('/app/hermes-studio/')) {
    throw new Error('生产前端未使用 /app/hermes-studio/ 资源前缀')
  }
}

async function writeFnosIcon(source, destination, size) {
  const padding = Math.max(2, Math.round(size * 0.025))
  await sharp(source)
    .trim({
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      threshold: 8,
    })
    .resize(size - padding * 2, size - padding * 2, { fit: 'contain' })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(destination)
}

function prepareLinuxNode(nodeArchive) {
  const nodeDir = join(CACHE_DIR, `node-v${CONFIG.node.version}-linux-x64`)
  const nodeBin = join(nodeDir, 'bin', 'node')
  if (!existsSync(nodeBin)) {
    rmSync(nodeDir, { recursive: true, force: true })
    log(`解压 Linux Node.js ${CONFIG.node.version}`)
    runWsl(['tar', '-xJf', toWslPath(nodeArchive), '-C', toWslPath(CACHE_DIR)])
  }
  const version = captureWsl([toWslPath(nodeBin), '--version'])
  if (version !== `v${CONFIG.node.version}`) throw new Error(`Linux Node 版本异常：${version}`)
  return { nodeDir, nodeBin }
}

function prepareNativeModules(nodeDir, nodeBin) {
  rmSync(NATIVE_DIR, { recursive: true, force: true })
  mkdirSync(NATIVE_DIR, { recursive: true })
  const runtimePackageDir = join(ROOT, 'scripts', 'fnos', 'runtime')
  copyFileSync(join(runtimePackageDir, 'package.json'), join(NATIVE_DIR, 'package.json'))
  copyFileSync(join(runtimePackageDir, 'package-lock.json'), join(NATIVE_DIR, 'package-lock.json'))

  const npmCli = join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const linuxNodeBinDir = dirname(toWslPath(nodeBin))
  const linuxSystemPath = captureWsl(['bash', '-lc', 'printf %s "$PATH"'])
  log('在 Linux 环境安装锁定的 node-pty/sharp/socket.io 生产依赖')
  runWsl([
    'env',
    `PATH=${linuxNodeBinDir}:${linuxSystemPath}`,
    toWslPath(nodeBin),
    toWslPath(npmCli),
    'ci',
    '--omit=dev',
    '--include=optional',
    '--no-bin-links',
    '--no-audit',
    '--no-fund',
  ], { cwd: toWslPath(NATIVE_DIR) })

  const imgDir = join(NATIVE_DIR, 'node_modules', '@img')
  const packages = existsSync(imgDir) ? readdirSync(imgDir) : []
  for (const required of ['sharp-linux-x64', 'sharp-libvips-linux-x64']) {
    if (!packages.includes(required)) throw new Error(`Linux Sharp 依赖缺失：@img/${required}`)
  }
  if (packages.some(name => name.includes('win32'))) throw new Error('Linux 原生依赖目录混入了 win32 Sharp 包')

  runWsl([
    toWslPath(nodeBin),
    '-e',
    "const s=require('sharp');s({create:{width:2,height:2,channels:4,background:'#204060'}}).png().toBuffer().then(b=>{if(!b.length)process.exit(2);console.log('[fnOS] Linux Sharp '+s.versions.sharp+' / libvips '+s.versions.vips)}).catch(e=>{console.error(e);process.exit(1)})",
  ], { cwd: toWslPath(NATIVE_DIR) })

  const nodePtyDir = join(NATIVE_DIR, 'node_modules', 'node-pty')
  rmSync(join(nodePtyDir, 'deps', 'winpty'), { recursive: true, force: true })
  rmSync(join(nodePtyDir, 'third_party', 'conpty'), { recursive: true, force: true })
  const prebuildsDir = join(nodePtyDir, 'prebuilds')
  if (existsSync(prebuildsDir)) {
    for (const entry of readdirSync(prebuildsDir)) {
      if (entry !== 'linux-x64') rmSync(join(prebuildsDir, entry), { recursive: true, force: true })
    }
  }
}

async function assembleStage(nodeBin, runtimeArchive) {
  rmSync(STAGE_DIR, { recursive: true, force: true })
  mkdirSync(dirname(STAGE_DIR), { recursive: true })
  cpSync(TEMPLATE_DIR, STAGE_DIR, { recursive: true })

  const appDir = join(STAGE_DIR, 'app')
  const runtimeDir = join(appDir, 'runtime')
  const binDir = join(appDir, 'bin')
  const imagesDir = join(appDir, 'ui', 'images')
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(imagesDir, { recursive: true })
  cpSync(join(ROOT, 'dist'), join(appDir, 'dist'), { recursive: true })
  rmSync(join(appDir, 'dist', 'server', 'index.js.map'), { force: true })
  cpSync(join(NATIVE_DIR, 'node_modules'), join(appDir, 'node_modules'), { recursive: true })
  rmSync(join(appDir, 'node_modules', '.bin'), { recursive: true, force: true })
  copyFileSync(join(ROOT, 'bin', 'hermes-studio-mcp.mjs'), join(binDir, 'hermes-studio-mcp.mjs'))

  const minimalPackage = {
    name: 'hermes-studio-fnos',
    private: true,
    version: APP_PACKAGE.version,
    description: 'Self-contained Hermes Studio runtime for fnOS',
  }
  validateBundledBrowserRuntime(runtimeArchive)
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify(minimalPackage, null, 2)}\n`)
  copyFileSync(join(ROOT, 'LICENSE'), join(appDir, 'LICENSE'))

  const packagedRuntime = join(runtimeDir, CONFIG.hermesRuntime.packageName)
  copyFileSync(runtimeArchive, packagedRuntime)
  writeFileSync(`${packagedRuntime}.sha256`, `${CONFIG.hermesRuntime.sha256}  ${CONFIG.hermesRuntime.packageName}\n`)

  const iconSource = join(ROOT, 'packages', 'desktop', 'build', 'icon.png')
  await writeFnosIcon(iconSource, join(STAGE_DIR, 'ICON.PNG'), 64)
  await writeFnosIcon(iconSource, join(STAGE_DIR, 'ICON_256.PNG'), 256)
  await writeFnosIcon(iconSource, join(imagesDir, 'icon_64.png'), 64)
  await writeFnosIcon(iconSource, join(imagesDir, 'icon_256.png'), 256)

  const blob = join(CACHE_DIR, 'hermes-studio.blob')
  rmSync(blob, { force: true })
  log('使用 Linux Node 生成并注入 SEA 启动 Blob')
  runWsl([
    toWslPath(nodeBin),
    '--experimental-sea-config',
    toWslPath(join(ROOT, 'scripts', 'fnos', 'sea-config.json')),
  ], { cwd: toWslPath(ROOT) })
  if (!existsSync(blob) || statSync(blob).size === 0) throw new Error('SEA Blob 未生成')

  const program = join(appDir, 'hermes-studio')
  copyFileSync(nodeBin, program)
  run(process.execPath, [
    join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    program,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    SEA_FUSE,
  ])
  const magic = readFileSync(program).subarray(0, 4).toString('hex')
  if (magic !== '7f454c46') throw new Error(`主程序不是 Linux ELF：${magic}`)

  const binarySha256 = await sha256File(program)
  const buildManifest = {
    schema: 1,
    app: { name: 'hermes-studio', version: APP_PACKAGE.version },
    target: CONFIG.target,
    sea: {
      nodeVersion: CONFIG.node.version,
      binary: 'hermes-studio',
      sha256: binarySha256,
    },
    hermesRuntime: {
      version: CONFIG.hermesRuntime.version,
      archive: CONFIG.hermesRuntime.packageName,
      sha256: CONFIG.hermesRuntime.sha256,
      size: CONFIG.hermesRuntime.size,
      sourceCommit: CONFIG.hermesRuntime.sourceCommit,
    },
    nativeModules: {
      nodePty: '1.1.0',
      sharp: '0.35.3',
      socketIo: '4.8.3',
      platform: 'linux-x64',
    },
    browser: {
      engine: 'agent-browser',
      mode: 'local',
      runtimePath: 'runtime/python/node/lib/node_modules/agent-browser',
      stream: true,
    },
  }
  writeFileSync(join(appDir, 'build-manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`)
  return program
}

function packageWithFnpack(fnpackPath) {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const outputName = `hermes-studio-${APP_PACKAGE.version}-linux-x64.fpk`
  const outputPath = join(OUTPUT_DIR, outputName)
  rmSync(outputPath, { force: true })

  const work = `/tmp/hermes-studio-fnos-build-${process.pid}`
  if (!work.startsWith('/tmp/hermes-studio-fnos-build-')) throw new Error('拒绝不安全的 WSL 临时目录')
  const linuxStage = `${work}/hermes-studio`
  const linuxOutput = `${work}/output`
  try {
    runWsl(['rm', '-rf', work])
    runWsl(['mkdir', '-p', linuxOutput])
    runWsl(['cp', '-a', toWslPath(STAGE_DIR), linuxStage])
    runWsl(['find', linuxStage, '-type', 'd', '-exec', 'chmod', '0755', '{}', '+'])
    runWsl(['find', linuxStage, '-type', 'f', '-exec', 'chmod', '0644', '{}', '+'])
    runWsl(['find', `${linuxStage}/cmd`, '-type', 'f', '-exec', 'chmod', '0755', '{}', '+'])
    runWsl(['chmod', '0755', `${linuxStage}/app/hermes-studio`])
    runWsl(['sh', '-n', `${linuxStage}/cmd/main`])
    runWsl(['sh', '-n', `${linuxStage}/cmd/runtime-install`])

    log(`使用飞牛官方 fnpack ${CONFIG.fnpack.version} 打包`)
    runWsl([toWslPath(fnpackPath), 'build', '--directory', linuxStage], { cwd: linuxOutput })
    const candidates = captureWsl([
      'find', work, '-maxdepth', '3', '-type', 'f', '-name', '*.fpk', '-print',
    ]).split(/\r?\n/).filter(Boolean)
    if (candidates.length !== 1) {
      throw new Error(`fnpack 输出数量异常：${candidates.join(', ') || '未找到 .fpk'}`)
    }
    runWsl(['cp', candidates[0], toWslPath(outputPath)])
  } finally {
    runWsl(['rm', '-rf', work])
  }
  if (!existsSync(outputPath) || statSync(outputPath).size < CONFIG.hermesRuntime.size) {
    throw new Error('最终 FPK 缺失或体积不足，可能是空壳')
  }
  return outputPath
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true })
  validateTemplate()
  if (captureWsl(['uname', '-m']) !== 'x86_64') throw new Error('WSL 不是 x86_64')

  buildWebUi()

  const [nodeArchive, runtimeArchive, fnpackPath] = await Promise.all([
    downloadPinned(CONFIG.node),
    downloadPinned(CONFIG.hermesRuntime),
    downloadPinned(CONFIG.fnpack),
  ])
  const { nodeDir, nodeBin } = prepareLinuxNode(nodeArchive)
  prepareNativeModules(nodeDir, nodeBin)
  await assembleStage(nodeBin, runtimeArchive)
  const fpk = packageWithFnpack(fnpackPath)

  log('执行完整 Linux 与成品反向验收')
  run(process.execPath, [join(ROOT, 'scripts', 'verify-fnos.mjs'), '--stage', STAGE_DIR, '--fpk', fpk])
  const sizeMiB = (statSync(fpk).size / 1024 / 1024).toFixed(1)
  log(`完成：${fpk} (${sizeMiB} MiB)`)
  log(`SHA256：${await sha256File(fpk)}`)
}

main().catch(error => {
  console.error(`[fnOS] 构建失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
