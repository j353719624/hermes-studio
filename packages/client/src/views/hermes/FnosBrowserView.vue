<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { browserAction, closeFnosBrowser, fnosBrowserStreamUrl, getFnosBrowserState, navigateFnosBrowser } from '@/api/hermes/fnos-browser'

const { t } = useI18n()
const message = useMessage()
const url = ref('about:blank')
const draftUrl = ref('about:blank')
const frame = ref('')
const frameBox = ref<HTMLElement | null>(null)
const streamSize = ref({ width: 1280, height: 720 })
const connected = ref(false)
const loading = ref(false)
const error = ref('')
let socket: WebSocket | null = null

function send(payload: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function handleStreamMessage(event: MessageEvent): void {
  if (typeof event.data !== 'string') return
  try {
    const payload = JSON.parse(event.data) as { type?: string; data?: string; metadata?: { deviceWidth?: number; deviceHeight?: number }; message?: string }
    if (payload.type === 'frame' && payload.data) {
      frame.value = `data:image/jpeg;base64,${payload.data}`
      if (payload.metadata?.deviceWidth && payload.metadata.deviceHeight) {
        streamSize.value = { width: payload.metadata.deviceWidth, height: payload.metadata.deviceHeight }
      }
    } else if (payload.type === 'error') {
      error.value = payload.message || t('browser.fnosStreamFailed')
    }
  } catch {
    // The stream protocol is JSON; ignore incomplete frames from a closing socket.
  }
}

function connectStream(): void {
  socket?.close()
  socket = new WebSocket(fnosBrowserStreamUrl())
  socket.onopen = () => {
    connected.value = true
    error.value = ''
  }
  socket.onmessage = handleStreamMessage
  socket.onerror = () => {
    connected.value = false
    error.value = t('browser.fnosStreamFailed')
  }
  socket.onclose = () => { connected.value = false }
}

async function refreshState(): Promise<void> {
  try {
    const state = await getFnosBrowserState()
    url.value = state.url
    draftUrl.value = state.url
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function submitUrl(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const state = await navigateFnosBrowser(draftUrl.value)
    url.value = state.url
    draftUrl.value = state.url
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function runAction(action: 'back' | 'forward' | 'reload'): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const state = await browserAction(action)
    url.value = state.url
    draftUrl.value = state.url
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function surfacePoint(event: MouseEvent): { x: number; y: number } | null {
  const element = frameBox.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return {
    x: Math.max(0, Math.min(streamSize.value.width, (event.clientX - rect.left) * streamSize.value.width / rect.width)),
    y: Math.max(0, Math.min(streamSize.value.height, (event.clientY - rect.top) * streamSize.value.height / rect.height)),
  }
}

function sendPointer(event: PointerEvent, eventType: 'mouseMoved' | 'mousePressed' | 'mouseReleased'): void {
  const point = surfacePoint(event)
  if (!point) return
  send({ type: 'input_mouse', eventType, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: eventType === 'mousePressed' ? 1 : 0 })
}

function sendKey(event: KeyboardEvent, eventType: 'keyDown' | 'keyUp'): void {
  if (event.isComposing) return
  event.preventDefault()
  send({ type: 'input_keyboard', eventType, key: event.key, code: event.code })
}

function handleWheel(event: WheelEvent): void {
  event.preventDefault()
  const point = surfacePoint(event)
  if (!point) return
  send({ type: 'input_mouse', eventType: 'mouseWheel', x: Math.round(point.x), y: Math.round(point.y), deltaX: event.deltaX, deltaY: event.deltaY })
}

async function closeBrowser(): Promise<void> {
  await closeFnosBrowser().catch(() => undefined)
  socket?.close()
  frame.value = ''
  connected.value = false
  message.success(t('browser.fnosClosed'))
}

onMounted(async () => {
  await refreshState()
  await nextTick()
  connectStream()
})

onBeforeUnmount(() => socket?.close())
</script>

<template>
  <section class="fnos-browser-page">
    <header class="browser-toolbar">
      <div class="browser-nav-buttons">
        <NButton quaternary circle :disabled="loading" @click="runAction('back')">‹</NButton>
        <NButton quaternary circle :disabled="loading" @click="runAction('forward')">›</NButton>
        <NButton quaternary circle :disabled="loading" @click="runAction('reload')">↻</NButton>
      </div>
      <form class="address-form" @submit.prevent="submitUrl">
        <NInput v-model:value="draftUrl" :placeholder="t('browser.fnosAddressPlaceholder')" :loading="loading" />
      </form>
      <NButton secondary @click="closeBrowser">{{ t('browser.fnosClose') }}</NButton>
    </header>
    <div class="browser-status">
      <span class="status-dot" :class="{ connected }" />
      <span>{{ connected ? t('browser.fnosConnected') : t('browser.fnosConnecting') }}</span>
      <span v-if="url" class="current-url">{{ url }}</span>
    </div>
    <div
      ref="frameBox"
      class="browser-surface"
      tabindex="0"
      @pointermove="sendPointer($event, 'mouseMoved')"
      @pointerdown="sendPointer($event, 'mousePressed')"
      @pointerup="sendPointer($event, 'mouseReleased')"
      @wheel="handleWheel"
      @keydown="sendKey($event, 'keyDown')"
      @keyup="sendKey($event, 'keyUp')"
    >
      <img v-if="frame" :src="frame" alt="" draggable="false" />
      <div v-else class="browser-empty">
        <span v-if="error">{{ error }}</span>
        <span v-else>{{ t('browser.fnosStarting') }}</span>
      </div>
    </div>
    <p v-if="error" class="browser-error">{{ error }}</p>
    <p class="browser-hint">{{ t('browser.fnosLocalHint') }}</p>
  </section>
</template>

<style scoped>
.fnos-browser-page { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--text-color); background: var(--body-color); }
.browser-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
.browser-nav-buttons { display: flex; gap: 2px; }
.address-form { flex: 1; min-width: 0; }
.browser-status { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 18px; color: var(--text-color-3); font-size: 12px; border-bottom: 1px solid var(--border-color); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #d97706; }
.status-dot.connected { background: #22c55e; }
.current-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .7; }
.browser-surface { position: relative; flex: 1; min-height: 0; overflow: hidden; outline: none; background: #fff; display: flex; align-items: flex-start; justify-content: center; }
.browser-surface img { width: 100%; height: auto; max-height: 100%; object-fit: contain; user-select: none; pointer-events: none; }
.browser-empty { height: 100%; width: 100%; display: grid; place-items: center; padding: 32px; text-align: center; color: #64748b; background: #f8fafc; }
.browser-error { margin: 0; padding: 8px 18px; color: #ef4444; font-size: 12px; }
.browser-hint { margin: 0; padding: 8px 18px 12px; color: var(--text-color-3); font-size: 12px; }
</style>
