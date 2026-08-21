import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getProfileDir } from '../hermes-profile'
import { assertAllowedWorkspaceFolder } from '../workspace-path'

export function defaultHermesWorkspace(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'workspace')
}

export async function ensureHermesRunWorkspace(profile: string, workspace?: string | null): Promise<string> {
  const raw = String(workspace || '').trim()
  if (raw) return (await assertAllowedWorkspaceFolder(raw)).fullPath

  const resolved = defaultHermesWorkspace(profile)
  await mkdir(resolved, { recursive: true })
  return resolved
}
