import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  appHome: '',
  remote: { hermes: ['0.20.4', '0.21.0'] },
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    fnos: true,
    get appHome() {
      return state.appHome
    },
  },
}))

vi.mock('../../packages/server/src/services/runtime-version-manager', () => ({
  fetchRemoteVersions: vi.fn(async () => ({ manifest: state.remote, error: '' })),
  runtimePlatformKey: vi.fn(() => 'linux-x64'),
  runtimeVersionManifestUrl: vi.fn(() => 'https://hermes-studio.ai/versions.json'),
  downloadAssetUrl: vi.fn(),
  downloadFile: vi.fn(),
  extractTarGzip: vi.fn(),
  fetchJson: vi.fn(),
  sha256File: vi.fn(),
  validateRuntimeDirectory: vi.fn(),
}))

const originalEnv = { ...process.env }
const tempDirs: string[] = []

describe('fnOS Runtime updater', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv, HERMES_FNOS_MODE: '1' }
    state.appHome = mkdtempSync(join(tmpdir(), 'hermes-fnos-runtime-'))
    tempDirs.push(state.appHome)
    process.env.HERMES_FNOS_RUNTIME_ROOT = join(state.appHome, 'runtime')
    mkdirSync(process.env.HERMES_FNOS_RUNTIME_ROOT, { recursive: true })
    writeFileSync(join(process.env.HERMES_FNOS_RUNTIME_ROOT, 'runtime-manifest.json'), JSON.stringify({
      hermesAgentVersion: '0.20.4',
    }))
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('reports the bundled Runtime and only official versions from the remote manifest', async () => {
    const { getFnosRuntimeStatus } = await import('../../packages/server/src/services/fnos-runtime-updater')
    const status = await getFnosRuntimeStatus()

    expect(status.currentVersion).toBe('0.20.4')
    expect(status.availableVersions).toEqual(['0.21.0', '0.20.4'])
    expect(status.runtimeRoot).toBe(process.env.HERMES_FNOS_RUNTIME_ROOT)
  })

  it('rejects unsafe or unlisted versions before starting an update', async () => {
    const { startFnosRuntimeUpgrade } = await import('../../packages/server/src/services/fnos-runtime-updater')

    await expect(startFnosRuntimeUpgrade('../runtime')).rejects.toThrow('version is invalid')
    await expect(startFnosRuntimeUpgrade('0.22.0')).rejects.toThrow('not available')
    await expect(startFnosRuntimeUpgrade('0.20.4')).rejects.toThrow('not newer')
  })
})
