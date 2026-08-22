import { arch, hostname, loadavg, platform, release, type, uptime } from 'node:os'
import { getPublicSystemInfo, type PublicSystemInfo } from '../system-info'
import { getFnosPlatformConfig } from './open-api'

export interface HermesFnosSystemInfo {
  isTrimMachine: boolean
  uptimeSeconds: number
  trimVersion: string | null
  kernelVersion: string | null
  platformConfig: Record<string, unknown> | null
  system: PublicSystemInfo
  host: {
    hostname: string
    type: string
    platform: string
    release: string
    arch: string
    loadAverage: number[]
  }
}

function optionalString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function safeUptime(): number {
  try {
    return Math.max(0, Math.floor(uptime()))
  } catch {
    return 0
  }
}

function safeLoadAverage(): number[] {
  try {
    return loadavg().map(value => Number.isFinite(value) ? value : 0)
  } catch {
    return []
  }
}

export async function getHermesFnosSystemInfo(): Promise<HermesFnosSystemInfo> {
  const [system, platformConfig] = await Promise.all([
    getPublicSystemInfo(),
    getFnosPlatformConfig(),
  ])

  const trimVersion = optionalString(process.env.TRIM_SYS_VERSION)
    || optionalString(platformConfig?.systemVersion)

  return {
    isTrimMachine: process.env.HERMES_FNOS_MODE === '1',
    uptimeSeconds: safeUptime(),
    trimVersion,
    kernelVersion: optionalString(process.env.TRIM_KERNEL_VERSION) || system.os.release,
    platformConfig,
    system,
    host: {
      hostname: hostname(),
      type: type(),
      platform: platform(),
      release: release(),
      arch: arch(),
      loadAverage: safeLoadAverage(),
    },
  }
}
