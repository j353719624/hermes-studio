import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { config } from '../config'
import {
  downloadAssetUrl,
  downloadFile,
  extractTarGzip,
  fetchJson,
  fetchRemoteVersions,
  runtimePlatformKey,
  runtimeVersionManifestUrl,
  sha256File,
  validateRuntimeDirectory,
  type RemoteVersionManifest,
  type RuntimePackageManifest,
} from './runtime-version-manager'

const DEFAULT_SOURCE = 'cf' as const
const MAX_RUNTIME_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024

export type FnosRuntimeUpdateStatus = 'queued' | 'running' | 'completed' | 'failed'
export type FnosRuntimeUpdateStage = 'resolve' | 'download' | 'verify' | 'extract' | 'install' | 'restart' | 'completed' | 'failed'

export interface FnosRuntimeUpdateJob {
  id: string
  version: string
  status: FnosRuntimeUpdateStatus
  stage: FnosRuntimeUpdateStage
  message: string
  error: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  restartPending: boolean
  createdAt: string
  updatedAt: string
}

export interface FnosRuntimeStatus {
  currentVersion: string
  platform: string
  runtimeRoot: string
  remoteManifestUrl: string
  remoteError: string
  availableVersions: string[]
  update: FnosRuntimeUpdateJob | null
}

let activeJob: FnosRuntimeUpdateJob | null = null

function isFnosMode(): boolean {
  return process.env.HERMES_FNOS_MODE === '1'
}

function runtimeRoot(): string {
  const configured = process.env.HERMES_FNOS_RUNTIME_ROOT?.trim()
  const root = configured ? resolve(configured) : resolve(config.appHome, '..', 'runtime')
  if (basename(root) !== 'runtime' || root === dirname(root)) {
    throw new Error('fnOS Runtime directory is invalid')
  }
  return root
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, '')
}

function validVersion(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function sortedVersions(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeVersion).filter(validVersion)))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
}

function cloneJob(job: FnosRuntimeUpdateJob | null): FnosRuntimeUpdateJob | null {
  return job ? { ...job } : null
}

function currentRuntimeVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'runtime-manifest.json'), 'utf8')) as { hermesAgentVersion?: unknown }
    return typeof parsed.hermesAgentVersion === 'string' ? normalizeVersion(parsed.hermesAgentVersion) : ''
  } catch {
    return ''
  }
}

function remoteVersions(manifest: RemoteVersionManifest | null): string[] {
  return sortedVersions(Array.isArray(manifest?.hermes) ? manifest.hermes : [])
}

function ensureSecureFnosUrl(url: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} is invalid`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`)
}

function updateMessage(stage: FnosRuntimeUpdateStage): string {
  return `fnosRuntimeUpdate.stage.${stage}`
}

function updateStage(job: FnosRuntimeUpdateJob, stage: FnosRuntimeUpdateStage, percent?: number): void {
  job.stage = stage
  job.message = updateMessage(stage)
  job.percent = percent
  job.updatedAt = new Date().toISOString()
}

function readRuntimePackageManifest(root: string): RuntimePackageManifest {
  try {
    return JSON.parse(readFileSync(join(root, 'runtime-manifest.json'), 'utf8')) as RuntimePackageManifest
  } catch {
    throw new Error('Extracted Hermes Runtime manifest is invalid')
  }
}

function commandPath(): string {
  const commandDir = process.env.HERMES_FNOS_CMD_DIR?.trim()
  if (!commandDir) throw new Error('fnOS service restart command is unavailable')
  const command = resolve(commandDir, 'main')
  if (!existsSync(command)) throw new Error('fnOS service restart command is missing')
  return command
}

function scheduleRestart(job: FnosRuntimeUpdateJob): void {
  const command = commandPath()
  const child = spawn('/bin/sh', [command, 'restart'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.once('error', error => {
    job.status = 'failed'
    job.stage = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
    job.message = updateMessage('failed')
    job.restartPending = false
    job.updatedAt = new Date().toISOString()
  })
  child.unref()
}

function activateRuntime(stage: string, target: string): void {
  const previous = `${target}.previous`
  rmSync(previous, { recursive: true, force: true })
  let movedCurrent = false
  try {
    if (existsSync(target)) {
      renameSync(target, previous)
      movedCurrent = true
    }
    renameSync(stage, target)
  } catch (error) {
    if (existsSync(target) && movedCurrent) rmSync(target, { recursive: true, force: true })
    if (movedCurrent && existsSync(previous) && !existsSync(target)) renameSync(previous, target)
    throw error
  }
}

async function runUpdate(job: FnosRuntimeUpdateJob): Promise<void> {
  const root = runtimeRoot()
  const platform = runtimePlatformKey()
  const storageRoot = dirname(root)
  const releaseTag = `hermes-${job.version}-runtime`
  const manifestName = `hermes-runtime-${platform}.json`
  const manifestUrl = downloadAssetUrl(manifestName, releaseTag, DEFAULT_SOURCE)
  const nonce = `${process.pid}-${Date.now()}`
  const archive = join(storageRoot, `.hermes-runtime-${nonce}.download`)
  const stage = join(storageRoot, `.hermes-runtime-update-${nonce}`)

  mkdirSync(storageRoot, { recursive: true })
  rmSync(stage, { recursive: true, force: true })
  rmSync(archive, { force: true })
  mkdirSync(stage, { recursive: true })

  try {
    updateStage(job, 'resolve')
    ensureSecureFnosUrl(runtimeVersionManifestUrl(), 'fnOS Runtime version manifest URL')
    ensureSecureFnosUrl(manifestUrl, 'fnOS Runtime package manifest URL')
    const packageManifest = await fetchJson<RuntimePackageManifest>(manifestUrl)
    const asset = packageManifest.asset
    const assetName = typeof asset?.name === 'string' ? basename(asset.name) : ''
    if (!assetName || assetName !== asset?.name || !assetName.endsWith('.tar.gz')) {
      throw new Error('Runtime package manifest contains an invalid archive name')
    }
    if (packageManifest.platform && packageManifest.platform !== platform) {
      throw new Error(`Runtime platform mismatch: expected ${platform}, received ${packageManifest.platform}`)
    }
    if (packageManifest.hermesAgentVersion && normalizeVersion(packageManifest.hermesAgentVersion) !== job.version) {
      throw new Error('Runtime package version does not match the selected Hermes Agent version')
    }
    const expectedHash = typeof asset.sha256 === 'string' ? asset.sha256.toLowerCase() : ''
    const expectedSize = Number(asset.size)
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Runtime package manifest is missing a valid SHA256')
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_RUNTIME_ARCHIVE_BYTES) {
      throw new Error('Runtime package manifest has an invalid archive size')
    }

    const assetUrl = downloadAssetUrl(assetName, releaseTag, DEFAULT_SOURCE)
    ensureSecureFnosUrl(assetUrl, 'fnOS Runtime package URL')
    updateStage(job, 'download')
    await downloadFile(assetUrl, archive, progress => {
      job.stage = 'download'
      job.message = updateMessage('download')
      job.percent = progress.percent
      job.receivedBytes = progress.receivedBytes
      job.totalBytes = progress.totalBytes
      job.updatedAt = new Date().toISOString()
    })

    updateStage(job, 'verify', 100)
    if (statSync(archive).size !== expectedSize) throw new Error('Runtime archive size verification failed')
    if (await sha256File(archive) !== expectedHash) throw new Error('Runtime archive SHA256 verification failed')

    updateStage(job, 'extract')
    await extractTarGzip(archive, stage)
    validateRuntimeDirectory(stage, platform)
    const extractedManifest = readRuntimePackageManifest(stage)
    if (normalizeVersion(String(extractedManifest.hermesAgentVersion || '')) !== job.version) {
      throw new Error('Extracted Runtime version does not match the selected Hermes Agent version')
    }

    updateStage(job, 'install')
    activateRuntime(stage, root)
    updateStage(job, 'restart')
    job.restartPending = true
    job.status = 'completed'
    job.stage = 'completed'
    job.message = updateMessage('completed')
    job.percent = 100
    job.updatedAt = new Date().toISOString()
    setTimeout(() => {
      try {
        scheduleRestart(job)
      } catch (error) {
        job.status = 'failed'
        job.stage = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        job.message = updateMessage('failed')
        job.restartPending = false
        job.updatedAt = new Date().toISOString()
      }
    }, 250).unref?.()
  } finally {
    rmSync(archive, { force: true })
    rmSync(stage, { recursive: true, force: true })
  }
}

export async function getFnosRuntimeStatus(): Promise<FnosRuntimeStatus> {
  if (!isFnosMode()) throw new Error('fnOS Runtime updates are only available on fnOS')
  const root = runtimeRoot()
  const { manifest, error } = await fetchRemoteVersions()
  return {
    currentVersion: currentRuntimeVersion(root),
    platform: runtimePlatformKey(),
    runtimeRoot: root,
    remoteManifestUrl: runtimeVersionManifestUrl(),
    remoteError: error,
    availableVersions: remoteVersions(manifest),
    update: cloneJob(activeJob),
  }
}

export async function startFnosRuntimeUpgrade(version: string): Promise<FnosRuntimeUpdateJob> {
  if (!isFnosMode()) throw new Error('fnOS Runtime updates are only available on fnOS')
  const cleanVersion = normalizeVersion(version)
  if (!validVersion(cleanVersion)) throw new Error('Hermes Agent version is invalid')
  if (activeJob?.status === 'queued' || activeJob?.status === 'running') return { ...activeJob }

  const { manifest, error } = await fetchRemoteVersions()
  if (error || !manifest) throw new Error(`Unable to load the official Hermes Agent version manifest: ${error || 'unknown error'}`)
  if (!remoteVersions(manifest).includes(cleanVersion)) throw new Error('The selected Hermes Agent version is not available')
  const currentVersion = currentRuntimeVersion(runtimeRoot())
  if (currentVersion && cleanVersion.localeCompare(currentVersion, undefined, { numeric: true }) <= 0) {
    throw new Error('The selected Hermes Agent version is not newer than the installed version')
  }
  commandPath()

  const now = new Date().toISOString()
  activeJob = {
    id: `fnos-runtime-${cleanVersion}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    version: cleanVersion,
    status: 'queued',
    stage: 'resolve',
    message: updateMessage('resolve'),
    error: '',
    restartPending: false,
    createdAt: now,
    updatedAt: now,
  }
  const job = activeJob
  queueMicrotask(() => {
    job.status = 'running'
    void runUpdate(job).catch(errorValue => {
      job.status = 'failed'
      job.stage = 'failed'
      job.message = updateMessage('failed')
      job.error = errorValue instanceof Error ? errorValue.message : String(errorValue)
      job.restartPending = false
      job.updatedAt = new Date().toISOString()
    })
  })
  return { ...job }
}
