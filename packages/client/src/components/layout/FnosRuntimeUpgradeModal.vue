<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NModal, NProgress, NSpin, NTag, useMessage } from 'naive-ui'
import {
  fetchFnosRuntimeStatus,
  upgradeFnosRuntime,
  type FnosRuntimeStatus,
  type FnosRuntimeUpdateJob,
} from '@/api/hermes/fnos-runtime'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (event: 'update:show', value: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const status = ref<FnosRuntimeStatus | null>(null)
const loading = ref(false)
const upgrading = ref(false)
const loadError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

const availableUpdates = computed(() => {
  const current = status.value?.currentVersion || ''
  return (status.value?.availableVersions || []).filter(version => (
    !current || version.localeCompare(current, undefined, { numeric: true }) > 0
  ))
})

const latestUpdate = computed(() => availableUpdates.value[0] || '')
const activeJob = computed(() => status.value?.update || null)
const isRunning = computed(() => activeJob.value?.status === 'queued' || activeJob.value?.status === 'running')

watch(() => props.show, show => {
  if (show) void loadStatus()
  else stopPolling()
})

onBeforeUnmount(stopPolling)

function updateShow(show: boolean) {
  emit('update:show', show)
}

async function loadStatus() {
  loading.value = true
  loadError.value = ''
  try {
    status.value = await fetchFnosRuntimeStatus()
    if (isRunning.value) startPolling()
    else stopPolling()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    stopPolling()
  } finally {
    loading.value = false
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void refreshStatus()
  }, 2000)
}

function stopPolling() {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

async function refreshStatus() {
  try {
    status.value = await fetchFnosRuntimeStatus()
    if (!isRunning.value) stopPolling()
  } catch {
    // The service may be restarting; keep the modal state until the next load.
  }
}

function jobMessage(job: FnosRuntimeUpdateJob): string {
  const key = job.message.startsWith('fnosRuntimeUpdate.') ? job.message : ''
  return key ? t(key) : job.message
}

async function upgrade(version: string) {
  if (!version || isRunning.value) return
  upgrading.value = true
  try {
    const result = await upgradeFnosRuntime(version)
    status.value = status.value ? { ...status.value, update: result.job } : status.value
    message.success(t('fnosRuntimeUpdate.started'))
    startPolling()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    upgrading.value = false
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    :title="t('fnosRuntimeUpdate.title')"
    style="width: min(560px, calc(100vw - 32px));"
    :closable="!isRunning"
    @update:show="updateShow"
  >
    <NSpin :show="loading">
      <div class="fnos-runtime-upgrade">
        <NAlert v-if="loadError" type="error" :bordered="false">{{ loadError }}</NAlert>
        <NAlert v-if="status?.remoteError" type="warning" :bordered="false">
          {{ t('fnosRuntimeUpdate.remoteLoadFailed') }}: {{ status.remoteError }}
        </NAlert>

        <div class="runtime-summary">
          <span>{{ t('fnosRuntimeUpdate.currentVersion') }}</span>
          <strong data-testid="fnos-current-runtime-version">{{ status?.currentVersion || '-' }}</strong>
          <span>{{ t('fnosRuntimeUpdate.platform') }}</span>
          <span>{{ status?.platform || '-' }}</span>
        </div>

        <NAlert type="info" :bordered="false">
          {{ t('fnosRuntimeUpdate.restartDescription') }}
        </NAlert>

        <div v-if="activeJob" class="runtime-job">
          <div class="runtime-job-heading">
            <strong>{{ t('fnosRuntimeUpdate.taskTitle', { version: activeJob.version }) }}</strong>
            <NTag size="small" :type="activeJob.status === 'failed' ? 'error' : activeJob.status === 'completed' ? 'success' : 'info'" :bordered="false">
              {{ jobMessage(activeJob) }}
            </NTag>
          </div>
          <NProgress
            v-if="activeJob.status === 'queued' || activeJob.status === 'running'"
            type="line"
            :percentage="Math.round(activeJob.percent || 0)"
            :show-indicator="typeof activeJob.percent === 'number'"
            processing
          />
          <NAlert v-if="activeJob.error" type="error" :bordered="false">{{ activeJob.error }}</NAlert>
          <NAlert v-if="activeJob.restartPending" type="success" :bordered="false">
            {{ t('fnosRuntimeUpdate.restartPending') }}
          </NAlert>
        </div>

        <div class="runtime-version-list">
          <div v-for="version in availableUpdates" :key="version" class="runtime-version-row">
            <div>
              <strong>{{ version }}</strong>
              <span v-if="version === latestUpdate" class="latest-label">{{ t('fnosRuntimeUpdate.latest') }}</span>
            </div>
            <NButton
              type="primary"
              size="small"
              :loading="upgrading && version === latestUpdate"
              :disabled="isRunning"
              :data-testid="`fnos-upgrade-${version}`"
              @click="upgrade(version)"
            >
              {{ t('fnosRuntimeUpdate.upgrade') }}
            </NButton>
          </div>
          <div v-if="availableUpdates.length === 0" class="empty-version-row">
            {{ t('fnosRuntimeUpdate.noUpdates') }}
          </div>
        </div>
      </div>
    </NSpin>
  </NModal>
</template>

<style scoped>
.fnos-runtime-upgrade {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.runtime-summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-color-2);
}

.runtime-summary strong {
  color: var(--text-color-1);
}

.runtime-job {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.runtime-job-heading,
.runtime-version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.runtime-version-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.runtime-version-row {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.latest-label {
  margin-left: 8px;
  color: var(--primary-color);
  font-size: 12px;
}

.empty-version-row {
  padding: 16px;
  color: var(--text-color-3);
  text-align: center;
}
</style>
