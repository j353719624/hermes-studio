import { randomBytes } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { getProfileUploadDir } from '../services/hermes/upload-paths'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../lib/multipart'
import { drainRejectedRequest, nonDestroyingRequestBody } from '../lib/request-body'
import { isPathWithin, isRealPathWithin } from '../services/hermes/hermes-path'
import { listFnosSharedAccessibleFolders } from '../services/fnos/open-api'

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function uploadName(name: string): string {
  const safeName = basename(name).replace(/[\\/\0]/g, '').trim()
  return safeName || 'attachment'
}

async function handleFnosPathUpload(ctx: any, body: unknown) {
  if (process.env.HERMES_FNOS_MODE !== '1') {
    ctx.status = 403
    ctx.body = { error: 'Shared-path upload is only available on fnOS', code: 'fnos_only' }
    return
  }
  const paths = Array.isArray((body as any)?.paths)
    ? (body as any).paths.filter((value: unknown): value is string => typeof value === 'string')
    : []
  if (paths.length === 0 || paths.length > 20) {
    ctx.status = 400
    ctx.body = { error: 'paths must contain between 1 and 20 files', code: 'invalid_paths' }
    return
  }

  const sharedRoots = await listFnosSharedAccessibleFolders()
  if (sharedRoots.length === 0) {
    ctx.status = 403
    ctx.body = { error: 'No fnOS shared folders are authorized for this app', code: 'shared_access_unavailable' }
    return
  }

  const uploadDir = getProfileUploadDir(requestedProfile(ctx))
  await mkdir(uploadDir, { recursive: true })
  const results: { name: string; path: string }[] = []
  for (const rawPath of paths) {
    if (!rawPath.trim() || !isAbsolute(rawPath) || rawPath.includes('\0')) {
      ctx.status = 400
      ctx.body = { error: 'Invalid file path', code: 'invalid_path' }
      return
    }
    const sourcePath = resolve(rawPath)
    const sharedRoot = sharedRoots.find(root => isPathWithin(sourcePath, resolve(root)))
    if (!sharedRoot || !await isRealPathWithin(sourcePath, resolve(sharedRoot))) {
      ctx.status = 403
      ctx.body = { error: 'The selected file is outside the authorized fnOS folders', code: 'permission_denied' }
      return
    }
    const info = await stat(sourcePath).catch(() => null)
    if (!info?.isFile()) {
      ctx.status = 400
      ctx.body = { error: `File not found: ${basename(sourcePath)}`, code: 'not_found' }
      return
    }
    if (info.size > MAX_UPLOAD_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)`, code: 'file_too_large' }
      return
    }
    const name = uploadName(basename(sourcePath))
    const savedPath = join(uploadDir, `${randomBytes(8).toString('hex')}${extname(name)}`)
    await writeFile(savedPath, await readFile(sourcePath))
    results.push({ name, path: savedPath })
  }
  ctx.body = { files: results }
}

export async function handleUpload(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (contentType.startsWith('application/json')) {
    await handleFnosPathUpload(ctx, ctx.request.body)
    return
  }
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data' }; return
  }
  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400; ctx.body = { error: 'Missing boundary' }; return
  }
  let chunks: Buffer[] = []
  let totalSize = 0
  let oversize = false
  // Leave the stream alive when the loop ends early; the iterator would
  // otherwise destroy it and take the unsent response down with it.
  const body = nonDestroyingRequestBody(ctx.req)
  for await (const chunk of body) {
    totalSize += chunk.length
    if (totalSize > MAX_UPLOAD_SIZE) {
      oversize = true
      break
    }
    chunks.push(chunk)
  }
  if (oversize) {
    chunks = []
    await drainRejectedRequest(ctx.req)
    ctx.status = 413
    ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }
    return
  }
  const raw = Buffer.concat(chunks)
  const parts = splitMultipart(raw, boundaryBuf)
  const results: { name: string; path: string }[] = []
  const uploadDir = getProfileUploadDir(requestedProfile(ctx))
  await mkdir(uploadDir, { recursive: true })
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)
    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400; ctx.body = { error: error.message }; return
      }
      throw error
    }
    if (!filename) continue
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    const savedName = randomBytes(8).toString('hex') + ext
    const savedPath = join(uploadDir, savedName)
    await writeFile(savedPath, data)
    results.push({ name: filename, path: savedPath })
  }
  ctx.body = { files: results }
}
