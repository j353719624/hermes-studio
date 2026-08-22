<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NCard, NInput, NModal, NSelect, NSwitch, NTabPane, NTabs, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  activateFnosBrowserProfile,
  clearFnosBrowserProfileData,
  createFnosBrowserProfile,
  deleteFnosBrowserProfile,
  getFnosBrowserConfig,
  updateFnosBrowserProfile,
  type FnosBrowserState,
} from '@/api/hermes/fnos-browser-config'
import { fnosTrimApp, pickFnosSharedFolder } from '@/utils/fnos-folder-picker'
import type { DesktopBrowserProfile } from '@/utils/desktop-bridge'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const state = ref<FnosBrowserState | null>(null)
const settingsProfileId = ref('')
const profileDraft = ref<DesktopBrowserProfile | null>(null)
const profileName = ref('')
const profileRootPath = ref('')
const profileProxyMode = ref<'direct' | 'system' | 'fixed_servers'>('direct')
const profileProxyRules = ref('')
const profileModalMode = ref<'create' | 'edit'>('create')
const showProfileModal = ref(false)
const busy = ref(false)
const loadError = ref('')
const pickingRoot = ref(false)
const trimApp = fnosTrimApp
const canPickFnosFolder = trimApp.isWeb && !trimApp.isStandaloneWeb

const profileOptions = computed(() => state.value?.profiles.map(profile => ({ label: profile.name, value: profile.id })) || [])
const conflictOptions = computed(() => [
  { label: t('browser.uniquifyDownloads'), value: 'uniquify' },
  { label: t('browser.askOnConflict'), value: 'ask' },
])
const proxyOptions = computed(() => [
  { label: t('browser.proxyDirect'), value: 'direct' },
  { label: t('browser.proxySystem'), value: 'system' },
  { label: t('browser.proxyCustom'), value: 'fixed_servers' },
])
const selectedDownloads = computed(() => state.value?.downloads.filter(item => item.profileId === settingsProfileId.value) || [])
const selectedPermissions = computed(() => state.value?.permissions.filter(item => item.profileId === settingsProfileId.value) || [])

watch(settingsProfileId, profileId => {
  const profile = state.value?.profiles.find(item => item.id === profileId)
  profileDraft.value = profile ? { ...profile, tabs: [...profile.tabs] } : null
})

function applyState(next: FnosBrowserState): void {
  state.value = next
  if (!settingsProfileId.value || !next.profiles.some(profile => profile.id === settingsProfileId.value)) {
    settingsProfileId.value = next.activeProfileId
  }
}

async function reload(): Promise<void> {
  applyState(await getFnosBrowserConfig())
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

function openCreateProfile(): void {
  profileModalMode.value = 'create'
  profileName.value = ''
  profileRootPath.value = ''
  profileProxyMode.value = 'direct'
  profileProxyRules.value = ''
  profileDraft.value = null
  showProfileModal.value = true
}

function openEditProfile(profile: DesktopBrowserProfile): void {
  profileModalMode.value = 'edit'
  settingsProfileId.value = profile.id
  profileDraft.value = { ...profile, tabs: [...profile.tabs] }
  showProfileModal.value = true
}

function closeProfileModal(): void {
  if (!busy.value) showProfileModal.value = false
}

async function chooseProfileRootDirectory(): Promise<void> {
  if (!canPickFnosFolder || pickingRoot.value) return
  pickingRoot.value = true
  try {
    const selected = await pickFnosSharedFolder(trimApp, {
      title: t('browser.fnosChooseProfileRootDirectory'),
      okText: t('browser.fnosChooseProfileRootDirectory'),
      sidebarGroup: ['myFiles', 'otherShare', 'external'],
    })
    if (selected) {
      if (profileModalMode.value === 'edit' && profileDraft.value) profileDraft.value.rootPath = selected
      else profileRootPath.value = selected
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('browser.fnosConfigSelectRootFailed'))
  } finally {
    pickingRoot.value = false
  }
}

function profilePath(root: string, name: 'data' | 'download'): string {
  const value = root.trim()
  if (!value) return name
  const separator = value.includes('\\') && !value.includes('/') ? '\\' : '/'
  return `${value.replace(/[\\/]+$/, '')}${separator}${name}`
}

async function switchProfile(profileId: string): Promise<void> {
  if (!state.value || profileId === state.value.activeProfileId) return
  await run(async () => applyState(await activateFnosBrowserProfile(profileId)))
}

async function createProfile(): Promise<void> {
  const name = profileName.value.trim()
  const rootDirectory = profileRootPath.value.trim()
  if (!name) return
  await run(async () => {
    const created = await createFnosBrowserProfile({
      name,
      rootDirectory,
      proxyMode: profileProxyMode.value,
      proxyRules: profileProxyRules.value.trim(),
    })
    showProfileModal.value = false
    await reload()
    settingsProfileId.value = created.id
  })
}

async function saveProfile(): Promise<void> {
  const draft = profileDraft.value
  if (!draft) return
  await run(async () => {
    await updateFnosBrowserProfile(draft.id, {
      name: draft.name,
      rootDirectory: draft.rootPath,
      proxyMode: draft.proxyMode,
      proxyRules: draft.proxyRules,
      askBeforeDownload: draft.askBeforeDownload,
      downloadConflictPolicy: draft.downloadConflictPolicy,
    })
    showProfileModal.value = false
    await reload()
    message.success(t('common.saved'))
  })
}

function deleteProfile(profileId: string): void {
  dialog.warning({
    title: t('browser.deleteProfileTitle'),
    content: t('browser.deleteProfileWarning'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => run(async () => applyState(await deleteFnosBrowserProfile(profileId))),
  })
}

function clearProfileData(kind: 'cache' | 'site-data' | 'permission-audit'): void {
  const profileId = settingsProfileId.value
  if (!profileId) return
  const clear = () => run(async () => {
    applyState(await clearFnosBrowserProfileData(profileId, kind))
    message.success(t('browser.dataCleared'))
  })
  if (kind !== 'site-data') {
    void clear()
    return
  }
  dialog.warning({
    title: t('browser.clearSiteData'),
    content: t('browser.clearSiteDataWarning'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: clear,
  })
}

onMounted(async () => {
  if (canPickFnosFolder) void trimApp.ready().catch(() => undefined)
  try {
    await reload()
  } catch (error) {
    loadError.value = `${t('browser.fnosConfigLoadFailed')}: ${error instanceof Error ? error.message : String(error)}`
  }
})
</script>

<template>
  <section class="browser-settings-page">
    <header class="page-header">
      <h2 class="header-title">{{ t('browser.title') }}</h2>
      <div class="header-actions">
        <NButton type="primary" size="small" :disabled="busy" @click="openCreateProfile">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </template>
          {{ t('browser.addProfile') }}
        </NButton>
      </div>
    </header>
    <div v-if="loadError" class="unavailable">{{ loadError }}</div>
    <NCard v-else class="settings-card" :bordered="false">
      <NTabs type="line" animated>
        <NTabPane name="profiles" :tab="t('browser.profiles')">
          <div v-if="state" class="profiles-grid">
            <article v-for="profile in state.profiles" :key="profile.id" class="profile-card" :class="{ active: profile.id === state.activeProfileId }">
              <div class="profile-card-header">
                <h3 :title="profile.name">{{ profile.name }}</h3>
                <span v-if="profile.id === state.activeProfileId" class="active-badge">{{ t('browser.currentProfile') }}</span>
              </div>
              <div class="profile-card-body">
                <div class="profile-info-row"><span>{{ t('browser.profileRootDirectory') }}</span><code :title="profile.rootPath">{{ profile.rootPath }}</code></div>
                <div class="profile-preferences">
                  <span>{{ t('browser.proxy') }} · {{ profile.proxyMode === 'fixed_servers' ? profile.proxyRules : profile.proxyMode === 'system' ? t('browser.proxySystem') : t('browser.proxyDirect') }}</span>
                  <span>{{ t('browser.askBeforeDownload') }} · {{ profile.askBeforeDownload ? t('common.enable') : t('common.disable') }}</span>
                  <span>{{ profile.downloadConflictPolicy === 'ask' ? t('browser.askOnConflict') : t('browser.uniquifyDownloads') }}</span>
                </div>
              </div>
              <div class="profile-card-actions">
                <NButton size="tiny" quaternary :disabled="busy || profile.id === state.activeProfileId" @click="switchProfile(profile.id)">{{ profile.id === state.activeProfileId ? t('browser.currentProfile') : t('browser.switchProfile') }}</NButton>
                <NButton size="tiny" quaternary :disabled="busy" @click="openEditProfile(profile)">{{ t('common.edit') }}</NButton>
                <NButton v-if="state.profiles.length > 1 && profile.id !== state.activeProfileId" size="tiny" quaternary type="error" :disabled="busy" @click="deleteProfile(profile.id)">{{ t('common.delete') }}</NButton>
              </div>
            </article>
          </div>
        </NTabPane>

        <NTabPane name="downloads" :tab="t('browser.downloads')">
          <label class="profile-filter">{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
          <div v-if="!selectedDownloads.length" class="empty">{{ t('common.noData') }}</div>
        </NTabPane>

        <NTabPane name="permissions" :tab="t('browser.permissions')">
          <label class="profile-filter">{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
          <p class="hint permissions-hint">{{ t('browser.permissionsHint') }}</p>
          <div class="form-actions">
            <NButton :disabled="busy" @click="clearProfileData('cache')">{{ t('browser.clearCache') }}</NButton>
            <NButton :disabled="busy" @click="clearProfileData('permission-audit')">{{ t('browser.clearPermissionAudit') }}</NButton>
            <NButton type="error" ghost :disabled="busy" @click="clearProfileData('site-data')">{{ t('browser.clearSiteData') }}</NButton>
          </div>
          <div v-if="!selectedPermissions.length" class="empty">{{ t('common.noData') }}</div>
        </NTabPane>
      </NTabs>
    </NCard>

    <NModal v-model:show="showProfileModal" preset="card" :title="profileModalMode === 'create' ? t('browser.addProfile') : t('browser.editProfile')" :style="{ width: 'min(620px, calc(100vw - 32px))' }" :mask-closable="!busy" :close-on-esc="!busy">
      <div v-if="profileModalMode === 'create'" class="settings-form">
        <label>{{ t('browser.profileName') }}<NInput v-model:value="profileName" autofocus /></label>
        <label>{{ t('browser.profileRootDirectory') }}<div class="path-row"><NInput v-model:value="profileRootPath" :placeholder="t('browser.chooseProfileRootDirectory')" /><NButton :loading="pickingRoot" :disabled="busy || !canPickFnosFolder" @click="chooseProfileRootDirectory">📁</NButton></div></label>
        <p class="hint">{{ t('browser.fnosProfileRootDirectoryHint', { data: profilePath(profileRootPath, 'data'), download: profilePath(profileRootPath, 'download') }) }}</p>
        <label>{{ t('browser.proxyMode') }}<NSelect v-model:value="profileProxyMode" :options="proxyOptions" /></label>
        <label v-if="profileProxyMode === 'fixed_servers'">{{ t('browser.proxyServer') }}<NInput v-model:value="profileProxyRules" :placeholder="t('browser.proxyServerPlaceholder')" /></label>
      </div>
      <div v-else-if="profileDraft" class="settings-form">
        <label>{{ t('browser.profileName') }}<NInput v-model:value="profileDraft.name" /></label>
        <label>{{ t('browser.profileRootDirectory') }}<div class="path-row"><NInput v-model:value="profileDraft.rootPath" /><NButton :loading="pickingRoot" :disabled="busy || !canPickFnosFolder" @click="chooseProfileRootDirectory">📁</NButton></div></label>
        <p class="hint">{{ t('browser.fnosProfileRootDirectoryHint', { data: profilePath(profileDraft.rootPath, 'data'), download: profilePath(profileDraft.rootPath, 'download') }) }}</p>
        <label>{{ t('browser.proxyMode') }}<NSelect v-model:value="profileDraft.proxyMode" :options="proxyOptions" /></label>
        <label v-if="profileDraft.proxyMode === 'fixed_servers'">{{ t('browser.proxyServer') }}<NInput v-model:value="profileDraft.proxyRules" :placeholder="t('browser.proxyServerPlaceholder')" /></label>
        <label class="switch-row"><span>{{ t('browser.askBeforeDownload') }}</span><NSwitch v-model:value="profileDraft.askBeforeDownload" /></label>
        <label>{{ t('browser.downloadConflictPolicy') }}<NSelect v-model:value="profileDraft.downloadConflictPolicy" :options="conflictOptions" /></label>
      </div>
      <template #footer>
        <div class="modal-actions"><NButton :disabled="busy" @click="closeProfileModal">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="busy" :disabled="profileModalMode === 'create' ? !profileName.trim() : !profileDraft?.name.trim()" @click="profileModalMode === 'create' ? createProfile() : saveProfile()">{{ profileModalMode === 'create' ? t('common.create') : t('common.save') }}</NButton></div>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
.browser-settings-page { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text-color); }
.hint { margin: 6px 0 0; color: var(--text-color-3); font-size: 12px; line-height: 1.5; }
.settings-card { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 20px; }
.settings-card :deep(.n-card__content) { max-width: 1120px; width: 100%; margin: 0 auto; }
.profiles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 14px; }
.profile-card { min-width: 0; display: flex; flex-direction: column; padding: 16px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); }
.profile-card.active { border-color: rgba(var(--accent-primary-rgb), .55); box-shadow: inset 0 0 0 1px rgba(var(--accent-primary-rgb), .1); }
.profile-card-header, .profile-card-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.profile-card-header { margin-bottom: 14px; }.profile-card-header h3 { min-width: 0; margin: 0; overflow: hidden; color: var(--text-primary); font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.active-badge { padding: 2px 8px; border-radius: 10px; background: rgba(var(--accent-primary-rgb), .12); color: var(--accent-primary); font-size: 11px; }
.profile-card-body { flex: 1; display: grid; gap: 12px; }.profile-info-row { min-width: 0; display: grid; gap: 4px; }.profile-info-row > span { color: var(--text-muted); font-size: 12px; }.profile-info-row code { overflow: hidden; color: var(--text-secondary); font: 11px var(--font-code, monospace); text-overflow: ellipsis; white-space: nowrap; }
.profile-preferences { display: flex; flex-wrap: wrap; gap: 6px; }.profile-preferences span { padding: 3px 7px; border-radius: 4px; background: rgba(var(--accent-primary-rgb), .08); color: var(--text-secondary); font-size: 11px; }
.profile-card-actions { justify-content: flex-start; margin-top: 14px; }.profile-filter { display: grid; gap: 6px; max-width: 320px; color: var(--text-secondary); font-size: 12px; }.empty { padding: 32px 12px; color: var(--text-color-3); text-align: center; }.permissions-hint { margin: 16px 0; }.form-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 8px; }.settings-form { display: grid; gap: 14px; }.settings-form label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 12px; }.path-row { display: flex; gap: 8px; }.path-row .n-input { flex: 1; }.switch-row { display: flex !important; align-items: center; justify-content: space-between; }.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }.unavailable { padding: 40px; text-align: center; color: var(--text-color-3); }
</style>
