import { ref } from 'vue'
import {
  downloadLocalSttModel,
  fetchLocalSttModelStatus,
  type LocalSttModelDownloadSource,
  type LocalSttModelStatus,
} from '@/api/hermes/local-stt-model'
import { isFnosMode } from '@/api/client'

const status = ref<LocalSttModelStatus | null>(null)
const loading = ref(false)

const FNOS_UNAVAILABLE_STATUS: LocalSttModelStatus = {
  id: 'fnos-disabled',
  name: 'Local STT unavailable on fnOS',
  languages: [],
  archiveSize: 0,
  extractedSize: 0,
  installed: false,
  usable: false,
  validationError: 'Local STT is not included in the portable fnOS build',
  job: null,
}

export function useLocalSttModel() {
  async function refresh(): Promise<LocalSttModelStatus> {
    if (isFnosMode()) {
      status.value = FNOS_UNAVAILABLE_STATUS
      return FNOS_UNAVAILABLE_STATUS
    }
    loading.value = true
    try {
      const next = await fetchLocalSttModelStatus()
      status.value = next
      return next
    } finally {
      loading.value = false
    }
  }

  async function download(source: LocalSttModelDownloadSource): Promise<void> {
    if (isFnosMode()) return
    const response = await downloadLocalSttModel(source)
    status.value = status.value
      ? { ...status.value, job: response.job }
      : await refresh()
  }

  return { status, loading, refresh, download }
}
