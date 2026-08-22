import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { config } from '../../config'

export type FnosBrowserProxyMode = 'direct' | 'system' | 'fixed_servers'

export interface FnosBrowserProfile {
  id: string
  name: string
  rootPath: string
  sessionPath: string
  downloadPath: string
  proxyMode: FnosBrowserProxyMode
  proxyRules: string
  askBeforeDownload: boolean
  downloadConflictPolicy: 'ask' | 'uniquify'
  createdAt: string
  lastUsedAt: string
  tabs: string[]
}

export interface FnosBrowserConfigState {
  available: true
  activeProfileId: string
  tabs: []
  profiles: FnosBrowserProfile[]
  downloads: []
  permissions: []
  visible: false
  maxTabs: 0
}

interface BrowserConfigDocument {
  schema: 1
  activeProfileId: string
  profiles: FnosBrowserProfile[]
}

export interface FnosBrowserProfileCreateInput {
  name: unknown
  rootDirectory: unknown
  proxyMode?: unknown
  proxyRules?: unknown
}

export interface FnosBrowserProfileUpdateInput {
  name?: unknown
  rootDirectory?: unknown
  proxyMode?: unknown
  proxyRules?: unknown
  askBeforeDownload?: unknown
  downloadConflictPolicy?: unknown
}

const browserRoot = resolve(config.appHome, 'browser')
const profilesFile = join(browserRoot, 'profiles.json')
const managedProfilesRoot = join(browserRoot, 'profiles')

function now(): string {
  return new Date().toISOString()
}

function isPathWithin(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeName(input: unknown): string {
  const name = String(input || '').trim().replace(/[\u0000-\u001f]/g, '')
  if (!name) throw new Error('请输入配置名称')
  if (name.length > 80) throw new Error('配置名称不能超过 80 个字符')
  return name
}

function safeProxyMode(input: unknown): FnosBrowserProxyMode {
  return input === 'system' || input === 'fixed_servers' ? input : 'direct'
}

function safeProxyRules(input: unknown, mode: FnosBrowserProxyMode): string {
  const rules = String(input || '').trim().replace(/[\u0000-\u001f]/g, '')
  if (rules.length > 2_048) throw new Error('代理服务器配置过长')
  if (mode === 'fixed_servers' && !rules) throw new Error('请输入代理服务器')
  return mode === 'fixed_servers' ? rules : ''
}

function copyProfile(profile: FnosBrowserProfile): FnosBrowserProfile {
  return { ...profile, tabs: [...profile.tabs] }
}

function managedProfileRoot(id: string): string {
  return join(managedProfilesRoot, id)
}

function profilePaths(rootPath: string): Pick<FnosBrowserProfile, 'rootPath' | 'sessionPath' | 'downloadPath'> {
  return {
    rootPath,
    sessionPath: join(rootPath, 'data'),
    downloadPath: join(rootPath, 'download'),
  }
}

async function ensureDirectory(pathname: string): Promise<string> {
  await mkdir(pathname, { recursive: true, mode: 0o700 })
  const canonical = await realpath(pathname)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error('配置目录不是文件夹')
  await access(canonical, constants.W_OK)
  return canonical
}

async function ensureProfileDirectories(profile: Pick<FnosBrowserProfile, 'sessionPath' | 'downloadPath'>): Promise<void> {
  await ensureDirectory(profile.sessionPath)
  await ensureDirectory(profile.downloadPath)
}

async function validateCustomRoot(input: unknown): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('请选择配置根目录')
  if (!isAbsolute(raw)) throw new Error('配置根目录必须是飞牛上的绝对路径')
  const canonical = await realpath(resolve(raw)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('配置根目录不存在')
    throw error
  })
  if (dirname(canonical) === canonical) throw new Error('不能使用文件系统根目录作为配置目录')
  if (isPathWithin(canonical, browserRoot) || isPathWithin(browserRoot, canonical)) {
    throw new Error('自定义配置目录不能与 Hermes Studio 浏览器数据目录重叠')
  }
  await access(canonical, constants.W_OK)
  return canonical
}

function defaultDocument(): BrowserConfigDocument {
  const id = randomUUID()
  const createdAt = now()
  const rootPath = managedProfileRoot(id)
  return {
    schema: 1,
    activeProfileId: id,
    profiles: [{
      id,
      name: 'Default',
      ...profilePaths(rootPath),
      proxyMode: 'direct',
      proxyRules: '',
      askBeforeDownload: true,
      downloadConflictPolicy: 'uniquify',
      createdAt,
      lastUsedAt: createdAt,
      tabs: [],
    }],
  }
}

function normalizeProfile(input: Partial<FnosBrowserProfile>, fallbackRoot: string): FnosBrowserProfile {
  const id = String(input.id || randomUUID())
  const rootPath = resolve(String(input.rootPath || fallbackRoot))
  const proxyMode = safeProxyMode(input.proxyMode)
  return {
    id,
    name: safeName(input.name || 'Default'),
    ...profilePaths(rootPath),
    proxyMode,
    proxyRules: safeProxyRules(input.proxyRules, proxyMode),
    askBeforeDownload: input.askBeforeDownload !== false,
    downloadConflictPolicy: input.downloadConflictPolicy === 'ask' ? 'ask' : 'uniquify',
    createdAt: String(input.createdAt || now()),
    lastUsedAt: String(input.lastUsedAt || now()),
    tabs: [],
  }
}

class FnosBrowserConfigStore {
  private document: BrowserConfigDocument | null = null
  private initializePromise: Promise<void> | null = null
  private persistQueue: Promise<void> = Promise.resolve()

  async initialize(): Promise<void> {
    if (this.document) return
    if (!this.initializePromise) {
      this.initializePromise = this.load().finally(() => { this.initializePromise = null })
    }
    await this.initializePromise
  }

  async state(): Promise<FnosBrowserConfigState> {
    await this.initialize()
    const document = this.requireDocument()
    return {
      available: true,
      activeProfileId: document.activeProfileId,
      tabs: [],
      profiles: document.profiles.map(copyProfile),
      downloads: [],
      permissions: [],
      visible: false,
      maxTabs: 0,
    }
  }

  async create(input: FnosBrowserProfileCreateInput): Promise<FnosBrowserProfile> {
    await this.initialize()
    const document = this.requireDocument()
    const id = randomUUID()
    const rootPath = String(input.rootDirectory || '').trim()
      ? await validateCustomRoot(input.rootDirectory)
      : await ensureDirectory(managedProfileRoot(id))
    const createdAt = now()
    const proxyMode = safeProxyMode(input.proxyMode)
    const profile: FnosBrowserProfile = {
      id,
      name: safeName(input.name),
      ...profilePaths(rootPath),
      proxyMode,
      proxyRules: safeProxyRules(input.proxyRules, proxyMode),
      askBeforeDownload: true,
      downloadConflictPolicy: 'uniquify',
      createdAt,
      lastUsedAt: createdAt,
      tabs: [],
    }
    await ensureProfileDirectories(profile)
    document.profiles.push(profile)
    await this.persist()
    return copyProfile(profile)
  }

  async update(profileId: string, input: FnosBrowserProfileUpdateInput): Promise<FnosBrowserProfile> {
    await this.initialize()
    const profile = this.requireProfile(profileId)
    const name = input.name === undefined ? profile.name : safeName(input.name)
    const proxyMode = input.proxyMode === undefined ? profile.proxyMode : safeProxyMode(input.proxyMode)
    const proxyRules = input.proxyRules === undefined && proxyMode === profile.proxyMode
      ? profile.proxyRules
      : safeProxyRules(input.proxyRules, proxyMode)
    let rootPath = profile.rootPath
    if (input.rootDirectory !== undefined && String(input.rootDirectory || '').trim() && resolve(String(input.rootDirectory)) !== resolve(profile.rootPath)) {
      rootPath = await validateCustomRoot(input.rootDirectory)
    }
    profile.name = name
    Object.assign(profile, profilePaths(rootPath))
    profile.proxyMode = proxyMode
    profile.proxyRules = proxyRules
    if (typeof input.askBeforeDownload === 'boolean') profile.askBeforeDownload = input.askBeforeDownload
    if (input.downloadConflictPolicy === 'ask' || input.downloadConflictPolicy === 'uniquify') profile.downloadConflictPolicy = input.downloadConflictPolicy
    await ensureProfileDirectories(profile)
    await this.persist()
    return copyProfile(profile)
  }

  async activate(profileId: string): Promise<FnosBrowserConfigState> {
    await this.initialize()
    const document = this.requireDocument()
    const profile = this.requireProfile(profileId)
    document.activeProfileId = profile.id
    profile.lastUsedAt = now()
    await this.persist()
    return this.state()
  }

  async delete(profileId: string): Promise<FnosBrowserConfigState> {
    await this.initialize()
    const document = this.requireDocument()
    if (document.profiles.length <= 1) throw new Error('至少要保留一个浏览器配置')
    const index = document.profiles.findIndex(profile => profile.id === profileId)
    if (index < 0) throw new Error('浏览器配置不存在')
    document.profiles.splice(index, 1)
    if (document.activeProfileId === profileId) document.activeProfileId = document.profiles[0].id
    await this.persist()
    return this.state()
  }

  async clear(profileId: string, kind: unknown): Promise<FnosBrowserConfigState> {
    await this.initialize()
    const profile = this.requireProfile(profileId)
    const requested = String(kind || '').trim()
    if (requested === 'cache') {
      for (const name of ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache']) {
        await rm(join(profile.sessionPath, name), { recursive: true, force: true })
      }
    } else if (requested === 'site-data') {
      await rm(profile.sessionPath, { recursive: true, force: true })
      await ensureDirectory(profile.sessionPath)
    } else if (requested !== 'permission-audit') {
      throw new Error('不支持的清理类型')
    }
    return this.state()
  }

  private async load(): Promise<void> {
    await mkdir(browserRoot, { recursive: true, mode: 0o700 })
    await chmod(browserRoot, 0o700)
    await mkdir(managedProfilesRoot, { recursive: true, mode: 0o700 })
    let document: BrowserConfigDocument | null = null
    try {
      const parsed = JSON.parse(await readFile(profilesFile, 'utf8')) as BrowserConfigDocument
      if (parsed?.schema === 1 && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        const profiles = parsed.profiles.map(profile => normalizeProfile(profile, managedProfileRoot(String(profile.id || randomUUID()))))
        const activeProfileId = profiles.some(profile => profile.id === parsed.activeProfileId) ? parsed.activeProfileId : profiles[0].id
        document = { schema: 1, activeProfileId, profiles }
      }
    } catch {
      // Recreate a valid configuration when the first install has no file or it is unreadable.
    }
    this.document = document || defaultDocument()
    for (const profile of this.document.profiles) {
      if (isPathWithin(profile.rootPath, managedProfilesRoot)) await ensureProfileDirectories(profile)
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    const write = this.persistQueue.catch(() => undefined).then(async () => {
      const document = this.requireDocument()
      const tempPath = `${profilesFile}.${process.pid}.tmp`
      await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await rename(tempPath, profilesFile)
      await chmod(profilesFile, 0o600)
    })
    this.persistQueue = write
    await write
  }

  private requireDocument(): BrowserConfigDocument {
    if (!this.document) throw new Error('浏览器配置尚未初始化')
    return this.document
  }

  private requireProfile(profileId: string): FnosBrowserProfile {
    const profile = this.requireDocument().profiles.find(item => item.id === profileId)
    if (!profile) throw new Error('浏览器配置不存在')
    return profile
  }
}

export const fnosBrowserConfigStore = new FnosBrowserConfigStore()
