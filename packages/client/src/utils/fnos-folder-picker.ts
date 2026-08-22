import { TrimApp } from '@trimjs/web-app'

const HOST_READY_TIMEOUT_MS = 8_000
const PICKER_TIMEOUT_MS = 30_000

type PickSharedFileParams = Parameters<TrimApp['pickSharedFile']>[0]
type PickSharedFileResult = Awaited<ReturnType<TrimApp['pickSharedFile']>>

// Keep one host bridge for the whole Web UI. Creating a new TrimApp for every
// modal repeats the postMessage handshake and makes the first click feel slow.
export const fnosTrimApp = new TrimApp()

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Start the fnOS shared-folder picker without allowing a broken host bridge
 * to leave the calling button in a permanent loading state.
 */
export async function pickFnosSharedFiles(
  app: TrimApp,
  params: PickSharedFileParams,
): Promise<string[]> {
  await withTimeout(
    app.ready(),
    HOST_READY_TIMEOUT_MS,
    'fnOS 文件选择器未连接',
  )

  const result = await withTimeout<PickSharedFileResult>(
    app.pickSharedFile(params),
    PICKER_TIMEOUT_MS,
    'fnOS 文件选择器没有响应',
  )

  if (result && result.code !== 0) {
    throw new Error(result.msg || 'fnOS 文件选择已取消')
  }

  return Array.isArray(result?.data)
    ? result.data.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : []
}

export async function pickFnosSharedFolder(
  app: TrimApp,
  params: PickSharedFileParams,
): Promise<string> {
  const paths = await pickFnosSharedFiles(app, params)
  return paths[0] || ''
}
