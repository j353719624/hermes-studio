import { request } from '@/api/client'

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

export async function fetchFnosRuntimeStatus(): Promise<FnosRuntimeStatus> {
  return request<FnosRuntimeStatus>('/api/hermes/fnos-runtime')
}

export async function upgradeFnosRuntime(version: string): Promise<{ success: boolean; job: FnosRuntimeUpdateJob }> {
  return request<{ success: boolean; job: FnosRuntimeUpdateJob }>('/api/hermes/fnos-runtime/upgrade', {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
}
