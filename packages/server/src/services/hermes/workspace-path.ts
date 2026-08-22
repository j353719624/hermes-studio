import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, resolve, win32 as pathWin32 } from 'path'
import { isPathWithin, isRealPathWithin } from './hermes-path'
import { listFnosSharedAccessibleFolders } from '../fnos/open-api'

export function workspaceBaseOverride(): string {
  return process.env.WORKSPACE_BASE?.trim() || ''
}

export function useWindowsDriveWorkspaceMode(): boolean {
  return process.platform === 'win32' && !workspaceBaseOverride()
}

function configuredWorkspaceRoots(): string[] {
  return [
    process.env.TRIM_DATA_ACCESSIBLE_PATHS,
    process.env.TRIM_DATA_SHARE_PATHS,
  ]
    .flatMap(value => String(value || '').split(delimiter))
    .map(value => value.trim())
    .filter(value => isAbsolute(value))
    .map(value => resolve(value))
}

async function allowedWorkspaceRoots(base: string): Promise<string[]> {
  const fnosRoots = process.env.HERMES_FNOS_MODE === '1'
    ? await listFnosSharedAccessibleFolders()
    : []
  return [...new Set([
    resolve(base),
    ...configuredWorkspaceRoots(),
    ...fnosRoots.filter(value => isAbsolute(value)).map(value => resolve(value)),
  ])]
}

/**
 * Return the roots that may be shown by the workspace picker.
 *
 * fnOS keeps the application workspace private, while directories selected
 * through the host are added to the same allow-list. The picker must use this
 * list instead of exposing the application's internal data path as its only
 * visible root.
 */
export async function listAllowedWorkspaceRoots(): Promise<string[]> {
  const base = resolve(workspaceBaseOverride() || homedir())
  const roots = await allowedWorkspaceRoots(base)
  return [...new Set(roots)].filter(root => existsSync(root))
}

function windowsDriveRoot(pathValue: string): string | null {
  const match = /^([a-zA-Z]:)[\\/]?$/.exec(pathValue.trim())
  return match ? `${match[1].toUpperCase()}\\` : null
}

export function normalizeWindowsWorkspacePath(inputPath: string): { base: string; fullPath: string } | null {
  const raw = String(inputPath || '').trim()
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) return null
  const fullPath = pathWin32.resolve(raw)
  const root = windowsDriveRoot(pathWin32.parse(fullPath).root)
  if (!root) return null
  const rel = pathWin32.relative(root, fullPath)
  if (rel.startsWith('..') || pathWin32.isAbsolute(rel)) return null
  return { base: root, fullPath }
}

export async function isWorkspaceListPathAllowed(
  fullPath: string,
  basePath: string,
  statFn: typeof stat,
  options: { trustWindowsDriveRoot?: boolean; trustWindowsJunctions?: boolean; realPathWithinFn?: typeof isRealPathWithin } = {},
): Promise<boolean> {
  try {
    const info = await statFn(fullPath)
    if (!info.isDirectory()) return false
    if (process.platform === 'win32' && options.trustWindowsDriveRoot) return true
    return await (options.realPathWithinFn || isRealPathWithin)(fullPath, basePath)
  } catch {
    return false
  }
}

export async function resolveAllowedWorkspaceFolder(inputPath: string): Promise<{ base: string; fullPath: string } | null> {
  const raw = String(inputPath || '').trim()
  if (!raw) return null

  if (useWindowsDriveWorkspaceMode()) {
    const resolved = normalizeWindowsWorkspacePath(raw)
    if (!resolved) return null
    return await isWorkspaceListPathAllowed(resolved.fullPath, resolved.base, stat, { trustWindowsDriveRoot: true }) ? resolved : null
  }

  const base = resolve(workspaceBaseOverride() || homedir())
  const fullPath = isAbsolute(raw) ? resolve(raw) : resolve(join(base, raw))
  const roots = await allowedWorkspaceRoots(base)
  const allowedRoot = roots.find(root => isPathWithin(fullPath, root))
  if (!allowedRoot || !existsSync(fullPath)) return null
  return await isWorkspaceListPathAllowed(fullPath, allowedRoot, stat)
    ? { base: allowedRoot, fullPath }
    : null
}

export async function assertAllowedWorkspaceFolder(inputPath: string): Promise<{ base: string; fullPath: string }> {
  const raw = String(inputPath || '').trim()
  const resolved = await resolveAllowedWorkspaceFolder(raw)
  if (resolved) return resolved
  const err = new Error(raw ? 'Workspace folder is not allowed' : 'workspace is required') as Error & { status?: number }
  err.status = raw ? 403 : 400
  throw err
}
