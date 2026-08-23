import { existsSync } from 'fs'
import { lstat, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, relative, resolve, win32 as pathWin32 } from 'path'
import { isPathWithin, isRealPathWithin } from './hermes-path'
import { listFnosSharedAccessibleFolders } from '../fnos/open-api'

export function workspaceBaseOverride(): string {
  return process.env.WORKSPACE_BASE?.trim() || ''
}

export function useWindowsDriveWorkspaceMode(): boolean {
  return process.platform === 'win32' && !workspaceBaseOverride()
}

export function isFnosStoragePath(pathValue: string): boolean {
  return process.env.HERMES_FNOS_MODE === '1' && /^\/vol\d+(?:\/|$)/i.test(pathValue)
}

async function containsSymlinkComponent(
  fullPath: string,
  basePath: string,
  lstatFn: typeof lstat,
): Promise<boolean> {
  const relativePath = relative(basePath, fullPath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return false

  let currentPath = basePath
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    currentPath = join(currentPath, segment)
    if ((await lstatFn(currentPath)).isSymbolicLink()) return true
  }
  return false
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

type FnosRootEntry = {
  name: string
  isDirectory(): boolean
}

/**
 * Discover fnOS storage volumes instead of using the application's data
 * directory as the only workspace root. fnOS mounts storage spaces as
 * /volN; other top-level system directories are intentionally excluded.
 */
export async function listFnosStorageRoots(
  readdirFn: (path: string, options: { withFileTypes: true }) => Promise<FnosRootEntry[]> = readdir as unknown as (path: string, options: { withFileTypes: true }) => Promise<FnosRootEntry[]>,
): Promise<string[]> {
  try {
    const entries = await readdirFn('/', { withFileTypes: true })
    const roots: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^vol\d+$/i.test(entry.name)) continue
      const root = `/${entry.name}`
      try {
        // A volume can exist while the package user cannot enumerate it.
        // Only advertise roots that this process can actually browse.
        await readdirFn(root, { withFileTypes: true })
        roots.push(root)
      } catch {
        // fnOS still exposes the native folder picker for inaccessible roots.
      }
    }
    return roots.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
}

async function allowedWorkspaceRoots(base: string): Promise<string[]> {
  const fnosRoots = process.env.HERMES_FNOS_MODE === '1'
    ? await listFnosSharedAccessibleFolders()
    : []
  const fnosStorageRoots = process.env.HERMES_FNOS_MODE === '1'
    ? await listFnosStorageRoots()
    : []
  return [...new Set([
    resolve(base),
    ...configuredWorkspaceRoots(),
    ...fnosRoots.filter(value => isAbsolute(value)).map(value => resolve(value)),
    ...fnosStorageRoots.map(value => resolve(value)),
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
  const roots = [...new Set(await allowedWorkspaceRoots(base))].filter(root => existsSync(root))
  // Keep fnOS-authorized paths as explicit roots even when a readable /volN
  // mount also exists above them. Otherwise the picker hides those grants by
  // collapsing every child into its parent volume.
  if (process.env.HERMES_FNOS_MODE === '1') return roots
  return roots.filter((root, index) => !roots.some((other, otherIndex) => (
    index !== otherIndex && other !== root && isPathWithin(root, other)
  )))
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
  options: { trustWindowsDriveRoot?: boolean; trustFnosStoragePath?: boolean; realPathWithinFn?: typeof isRealPathWithin; lstatFn?: typeof lstat } = {},
): Promise<boolean> {
  try {
    const info = await statFn(fullPath)
    if (!info.isDirectory()) return false
    if (process.platform === 'win32' && options.trustWindowsDriveRoot) return true
    // fnOS storage volumes can be mount points whose realpath is not a
    // lexical child of the volume path. Keep the package-user permission
    // check above, but do not hide ordinary directories under an authorized
    // /volN mount just because realpath crosses that mount boundary.
    if (options.trustFnosStoragePath && isFnosStoragePath(basePath) && isPathWithin(fullPath, basePath)) {
      // Mount points are valid fnOS storage boundaries; symlinks are not.
      // Check every path component so an intermediate link cannot escape the volume.
      if (await containsSymlinkComponent(fullPath, basePath, options.lstatFn || lstat)) return false
      return true
    }
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
  return await isWorkspaceListPathAllowed(fullPath, allowedRoot, stat, {
    trustFnosStoragePath: isFnosStoragePath(allowedRoot),
  })
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
