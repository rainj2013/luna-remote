import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bookmark as BookmarkIcon, Bot, Check, ChevronDown, ChevronRight, CircleHelp, CirclePlus, Copy, Download, Edit3, ExternalLink, Eye, EyeOff, File, FileInput, FileJson2, Folder, FolderOpen, FolderPlus, GripVertical, History as HistoryIcon, Image as ImageIcon, Info, KeyRound, Languages, Maximize2, Minimize2, Minus, Monitor, Moon, Network, Palette, PanelLeftClose, PanelLeftOpen, Play, Plug, Power, Rocket, Search, Send, Server, Settings as SettingsIcon, ShieldAlert, Square, SquareTerminal, Star, Sun, Trash2, Upload, WandSparkles, X } from 'lucide-react'
import { BUNDLED_TERMINAL_FONT, DEFAULT_AI_SETTINGS, DEFAULT_TERMINAL_SETTINGS, type AiCommandHistoryEntry, type AiCommandSuggestion, type AiProvider, type AiRawExchange, type AiRiskAssessment, type AiSettings, type AiSettingsInput, type AiShell, type AiThinkingMode, type AppEvent, type AppIconId, type AppIconSettings, type AppLanguage, type Bookmark, type BookmarkInput, type ConflictResolution, type ConnectInput, type DeploymentBundle, type DeploymentPreview, type DeploymentPreviewProgress, type DeploymentProgress, type DeploymentRun, type DeploymentProfile, type DirectoryEntry, type HostKeyPrompt, type PortForwardProfile, type SessionStatus, type SshConfigPreview, type TerminalSettings, type TransferTask, type TunnelSummary, type UiTheme, type WebApiConfig, type WebApiStatus } from './types'
import { TerminalPane, type TerminalPaneHandle } from './components/TerminalPane'
import { SftpPane } from './components/SftpPane'
import { HelpDialog } from './components/HelpDialog'
import { formatWebApiEndpoint, formatWebApiReference, webApiEndpoints } from './deployment-web-api-reference'
import { colorWithOpacity, terminalBackgroundStyle } from './terminal-style'
import { availableLanguages, getNativeMenuLabels, useI18n, type MessageKey } from './i18n'

interface WorkspaceTab { key: string; bookmarkId: string; sessionId?: string; status: SessionStatus; error?: string }
interface ConnectionTarget { newSession?: boolean; tabKey?: string }
interface SidebarContextMenu { x: number; y: number; group?: string; bookmark?: Bookmark }
interface GroupDialogState { mode: 'create' | 'rename'; group?: string }
type SettingsSection = 'appearance' | 'terminal' | 'ai' | 'webApi' | 'about'
type SidebarPointerDrag = { pointerId: number; type: 'bookmark' | 'group'; value: string; startX: number; startY: number; active: boolean }
type SidebarPointerDrop = { type: 'bookmark'; id: string; group: string; position: 'before' | 'after' } | { type: 'group'; group: string; position: 'before' | 'after' | 'inside' }
type ConfirmationOptions = { title: string; message: string; detail?: string; kind: 'warning' | 'danger'; confirmLabel: string }
type ConfirmAction = (options: ConfirmationOptions) => Promise<boolean>
type PendingConfirmation = ConfirmationOptions & { resolve(value: boolean): void }

const emptyBookmark: BookmarkInput = { name: '', host: '', port: 22, username: '', authType: 'password', privateKeyPath: '', jumpBookmarkId: '', groupName: '', favorite: false, keepaliveEnabled: true, keepaliveIntervalSeconds: 15, keepaliveCountMax: 3, note: '' }
type ConnectionCredentials = Omit<ConnectInput, 'bookmarkId' | 'newSession'>
const defaultSidebarWidth = 260
const minSidebarWidth = 200
const maxSidebarWidth = 480
const aiTerminalContextLines = 100
const aiTerminalContextChars = 16_000
const repositoryUrl = 'https://github.com/rainj2013/luna-remote'
const appIconMessageKeys: Record<AppIconId, MessageKey> = { ssh: 'appIcon.ssh', classic: 'appIcon.classic', neon: 'appIcon.neon', light: 'appIcon.light' }
const deploymentVariables: ReadonlyArray<{ name: string; descriptionKey: MessageKey }> = [
  { name: 'UPLOAD_DIR', descriptionKey: 'deployment.variable.target' },
  { name: 'FILE_NAME', descriptionKey: 'deployment.variable.fileName' },
  { name: 'FILE_PATH', descriptionKey: 'deployment.variable.filePath' },
]
const deploymentHookVariables: ReadonlyArray<{ name: string; descriptionKey: MessageKey }> = [
  { name: 'deploymentName', descriptionKey: 'deployment.hookVariable.deploymentName' },
  { name: 'finishedAt', descriptionKey: 'deployment.hookVariable.finishedAt' },
  { name: 'durationSeconds', descriptionKey: 'deployment.hookVariable.durationSeconds' },
  { name: 'archiveSizeText', descriptionKey: 'deployment.hookVariable.archiveSizeText' },
  { name: 'selectedFileCount', descriptionKey: 'deployment.hookVariable.selectedFileCount' },
  { name: 'succeeded', descriptionKey: 'deployment.hookVariable.succeeded' },
  { name: 'summary', descriptionKey: 'deployment.hookVariable.summary' },
  { name: 'error', descriptionKey: 'deployment.hookVariable.error' },
]

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do { value /= 1024; unit += 1 } while (value >= 1024 && unit < units.length - 1)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 }).format(value)} ${units[unit]}`
}

function primaryFontName(fontFamily: string): string {
  return fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '') || 'JetBrains Mono'
}

function terminalFontStack(fontName: string): string {
  const escaped = fontName.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return escaped ? `"${escaped}", "JetBrains Mono", monospace` : BUNDLED_TERMINAL_FONT
}

function clampSidebarWidth(width: number): number {
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(width)))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function App(): React.JSX.Element {
  const { language, setLanguage, t } = useI18n()
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [tabs, setTabs] = useState<WorkspaceTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [query, setQuery] = useState('')
  const [bookmarkDialog, setBookmarkDialog] = useState<Bookmark | 'new' | null>(null)
  const [authRequest, setAuthRequest] = useState<{ bookmark: Bookmark; target: ConnectionTarget } | null>(null)
  const [hostPrompts, setHostPrompts] = useState<HostKeyPrompt[]>([])
  const [conflict, setConflict] = useState<{ taskId: string; sourcePath: string; destinationPath: string } | null>(null)
  const [transfers, setTransfers] = useState<TransferTask[]>([])
  const [transferView, setTransferView] = useState<'queue' | 'history'>('queue')
  const [workspaceView, setWorkspaceView] = useState<'terminal' | 'files'>('terminal')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [collapsedBookmarkGroups, setCollapsedBookmarkGroups] = useState<Set<string>>(new Set())
  const [bookmarkGroupNames, setBookmarkGroupNames] = useState<string[]>([])
  const [selectedBookmarkId, setSelectedBookmarkId] = useState('')
  const [draggedBookmarkId, setDraggedBookmarkId] = useState('')
  const [bookmarkDrop, setBookmarkDrop] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const [draggedGroupName, setDraggedGroupName] = useState<string | null>(null)
  const [groupDrop, setGroupDrop] = useState<{ group: string; position: 'before' | 'after' | 'inside' } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth)
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS)
  const [terminalBackground, setTerminalBackground] = useState('')
  const [uiTheme, setUiTheme] = useState<UiTheme>('system')
  const [savedLanguage, setSavedLanguage] = useState<AppLanguage>(language)
  const [uiThemePreview, setUiThemePreview] = useState<UiTheme | null>(null)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [appIcons, setAppIcons] = useState<AppIconSettings>({ selected: 'ssh', options: [] })
  const [aiSettings, setAiSettings] = useState<AiSettings>({ ...DEFAULT_AI_SETTINGS })
  const [aiDialog, setAiDialog] = useState(false)
  const [settingsDialog, setSettingsDialog] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('appearance')
  const [helpDialog, setHelpDialog] = useState(false)
  const [deploymentDialog, setDeploymentDialog] = useState(false)
  const [tunnelDialog, setTunnelDialog] = useState(false)
  const [importPreview, setImportPreview] = useState<SshConfigPreview | null>(null)
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SidebarContextMenu | null>(null)
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [toast, setToast] = useState('')
  const [toastKind, setToastKind] = useState<'error' | 'success'>('error')
  const stateRestored = useRef(false)
  const sidebarWidthRef = useRef(defaultSidebarWidth)
  const sidebarPointerDragRef = useRef<SidebarPointerDrag | null>(null)
  const sidebarPointerDropRef = useRef<SidebarPointerDrop | null>(null)
  const suppressSidebarClickRef = useRef(false)
  const terminalPaneRefs = useRef(new Map<string, TerminalPaneHandle>())

  const showToast = (message: string, kind: 'error' | 'success' = 'error'): void => { setToastKind(kind); setToast(message); setTimeout(() => setToast(''), 4500) }
  const showError = (message: string): void => showToast(message)
  const confirmAction: ConfirmAction = (options) => new Promise((resolve) => setConfirmation({ ...options, resolve }))
  const resolveConfirmation = (accepted: boolean): void => {
    if (!confirmation) return
    confirmation.resolve(accepted)
    setConfirmation(null)
  }
  const openSettings = (section: SettingsSection = 'appearance'): void => { setSettingsInitialSection(section); setSettingsDialog(true) }
  const reloadBookmarks = async (): Promise<void> => setBookmarks(await window.api.bookmarks.list())
  const reloadSidebarData = async (): Promise<void> => {
    const [items, groups] = await Promise.all([window.api.bookmarks.list(), window.api.bookmarkGroups.list()])
    setBookmarks(items)
    setBookmarkGroupNames(groups)
  }

  useEffect(() => {
    void Promise.all([window.api.bookmarks.list(), window.api.bookmarkGroups.list(), window.api.transfers.list(), window.api.state.getSidebarCollapsed(), window.api.state.getCollapsedBookmarkGroups(), window.api.state.getSidebarWidth(), window.api.settings.getTerminal(), window.api.settings.getAppIcons(), window.api.settings.getUiTheme(), window.api.ai.getSettings()]).then(([items, groups, transferItems, collapsed, collapsedGroups, width, appearance, icons, theme, ai]) => {
      setBookmarks(items); setTransfers(transferItems)
      setBookmarkGroupNames(groups)
      setSidebarCollapsed(collapsed)
      setCollapsedBookmarkGroups(new Set(collapsedGroups))
      sidebarWidthRef.current = width
      setSidebarWidth(width)
      setTerminalSettings(appearance)
      setAppIcons(icons)
      setUiTheme(theme)
      setAiSettings(ai)
      if (appearance.backgroundImagePath) void window.api.settings.loadTerminalBackground(appearance.backgroundImagePath).then(setTerminalBackground).catch(() => setTerminalBackground(''))
      stateRestored.current = true
    }).catch((error) => showError(errorMessage(error)))
  }, [])

  useEffect(() => { if (stateRestored.current) void window.api.state.setSidebarCollapsed(sidebarCollapsed).catch((error) => showError(errorMessage(error))) }, [sidebarCollapsed])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (window.api.platform !== 'win32') return
    const preventBrowserMenu = (event: MouseEvent): void => event.preventDefault()
    document.addEventListener('contextmenu', preventBrowserMenu)
    return () => document.removeEventListener('contextmenu', preventBrowserMenu)
  }, [])

  useEffect(() => {
    if (window.api.platform !== 'darwin') return
    document.documentElement.spellcheck = false
    const disableTextCorrections = (target: EventTarget | null): void => {
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable)) return
      target.setAttribute('spellcheck', 'false')
      target.setAttribute('autocorrect', 'off')
      target.setAttribute('autocapitalize', 'off')
    }
    const onFocus = (event: FocusEvent): void => disableTextCorrections(event.target)
    const configureTree = (node: Node): void => {
      disableTextCorrections(node)
      if (node instanceof Element) node.querySelectorAll('input, textarea, [contenteditable]').forEach(disableTextCorrections)
    }
    configureTree(document.body)
    const observer = new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(configureTree)))
    observer.observe(document.body, { childList: true, subtree: true })
    disableTextCorrections(document.activeElement)
    document.addEventListener('focusin', onFocus, true)
    return () => { observer.disconnect(); document.removeEventListener('focusin', onFocus, true) }
  }, [])

  useEffect(() => {
    if (!sidebarContextMenu) return
    const close = (): void => setSidebarContextMenu(null)
    const closeOnKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', closeOnKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', closeOnKey)
    }
  }, [sidebarContextMenu])

  useEffect(() => window.api.onEvent((event: AppEvent) => {
    if (event.type === 'session') {
      setTabs((current) => current.map((tab) => tab.sessionId === event.payload.id ? { ...tab, status: event.payload.status, error: event.payload.error } : tab))
      if (event.payload.status === 'connected') void reloadBookmarks()
      if (['disconnected', 'error'].includes(event.payload.status)) setHostPrompts((current) => current.filter((item) => item.sessionId !== event.payload.id))
    }
    if (event.type === 'host-key') setHostPrompts((current) => current.some((item) => item.sessionId === event.payload.sessionId && item.fingerprint === event.payload.fingerprint) ? current : [...current, event.payload])
    if (event.type === 'transfer') {
      setTransfers((current) => [event.payload, ...current.filter((item) => item.id !== event.payload.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      if (event.payload.status !== 'conflict') setConflict((current) => current?.taskId === event.payload.id ? null : current)
    }
    if (event.type === 'transfer-conflict') setConflict(event.payload)
  }), [])

  const bookmarkMap = useMemo(() => new Map(bookmarks.map((item) => [item.id, item])), [bookmarks])
  const activeTab = tabs.find((tab) => tab.key === activeKey)
  const activeBookmark = activeTab ? bookmarkMap.get(activeTab.bookmarkId) : undefined
  const selectedBookmark = bookmarkMap.get(selectedBookmarkId) ?? activeBookmark
  const filteredBookmarks = bookmarks.filter((item) => `${item.name} ${item.host} ${item.username} ${item.groupName} ${item.note}`.toLowerCase().includes(query.toLowerCase()))
  const bookmarkGroups = useMemo(() => {
    const groups = new Map(bookmarkGroupNames.map((group) => [group, [] as Bookmark[]]))
    for (const bookmark of filteredBookmarks) {
      const group = bookmark.groupName
      groups.set(group, [...(groups.get(group) ?? []), bookmark])
    }
    return [...groups].filter(([, items]) => !query || items.length > 0)
  }, [bookmarkGroupNames, filteredBookmarks, query])

  const toggleBookmarkGroup = (group: string): void => {
    setCollapsedBookmarkGroups((current) => {
      const next = new Set(current)
      if (next.has(group)) next.delete(group); else next.add(group)
      void window.api.state.setCollapsedBookmarkGroups([...next]).catch((error) => showError(errorMessage(error)))
      return next
    })
  }

  const moveBookmark = async (sourceId: string, targetGroup: string, targetId?: string, position: 'before' | 'after' = 'after'): Promise<void> => {
    if (!sourceId || sourceId === targetId || query) return
    const source = bookmarks.find((bookmark) => bookmark.id === sourceId)
    if (!source || !bookmarkGroupNames.includes(targetGroup)) return
    const next = bookmarks.filter((bookmark) => bookmark.id !== sourceId)
    let targetIndex = targetId ? next.findIndex((bookmark) => bookmark.id === targetId) : -1
    if (targetIndex < 0) {
      targetIndex = next.reduce((last, bookmark, index) => bookmark.groupName === targetGroup ? index : last, -1)
      position = 'after'
    }
    next.splice(targetIndex < 0 ? next.length : targetIndex + (position === 'after' ? 1 : 0), 0, { ...source, groupName: targetGroup })
    setBookmarks(next)
    try {
      if (source.groupName !== targetGroup) await window.api.bookmarks.moveToGroup(sourceId, targetGroup)
      setBookmarks(await window.api.bookmarks.reorder(next.map((bookmark) => bookmark.id)))
    }
    catch (error) { showError(errorMessage(error)); await reloadBookmarks() }
  }

  const reorderBookmarkGroup = async (sourceGroup: string, targetGroup: string, position: 'before' | 'after'): Promise<void> => {
    if (sourceGroup === targetGroup || query) return
    const previous = bookmarkGroupNames
    const next = bookmarkGroupNames.filter((group) => group !== sourceGroup)
    const targetIndex = next.indexOf(targetGroup)
    if (targetIndex < 0) return
    next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceGroup)
    setBookmarkGroupNames(next)
    try { setBookmarkGroupNames(await window.api.bookmarkGroups.reorder(next)) }
    catch (error) { setBookmarkGroupNames(previous); showError(errorMessage(error)) }
  }

  const finishSidebarDrag = (): void => {
    setDraggedBookmarkId('')
    setDraggedGroupName(null)
    setBookmarkDrop(null)
    setGroupDrop(null)
  }

  const startSidebarPointerDrag = (event: React.PointerEvent, type: 'bookmark' | 'group', value: string): void => {
    if (event.button !== 0 || query || sidebarPointerDragRef.current) return
    const drag: SidebarPointerDrag = { pointerId: event.pointerId, type, value, startX: event.clientX, startY: event.clientY, active: false }
    sidebarPointerDragRef.current = drag
    sidebarPointerDropRef.current = null

    const move = (moveEvent: PointerEvent): void => {
      const current = sidebarPointerDragRef.current
      if (!current || moveEvent.pointerId !== current.pointerId) return
      if (!current.active && Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) < 5) return
      if (!current.active) {
        current.active = true
        document.body.classList.add('sidebar-item-dragging')
        if (current.type === 'bookmark') { setSelectedBookmarkId(current.value); setDraggedBookmarkId(current.value) }
        else setDraggedGroupName(current.value)
      }
      moveEvent.preventDefault()
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null
      if (current.type === 'bookmark') {
        const bookmarkElement = target?.closest<HTMLElement>('[data-bookmark-id]')
        if (bookmarkElement?.dataset.bookmarkId && bookmarkElement.dataset.bookmarkId !== current.value) {
          const targetBookmark = bookmarks.find((bookmark) => bookmark.id === bookmarkElement.dataset.bookmarkId)
          if (targetBookmark) {
            const bounds = bookmarkElement.getBoundingClientRect()
            const position = moveEvent.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
            sidebarPointerDropRef.current = { type: 'bookmark', id: targetBookmark.id, group: targetBookmark.groupName, position }
            setBookmarkDrop({ id: targetBookmark.id, position })
            setGroupDrop(null)
            return
          }
        }
        const groupElement = target?.closest<HTMLElement>('[data-group-name]')
        if (groupElement?.dataset.groupName !== undefined) {
          const group = groupElement.dataset.groupName
          sidebarPointerDropRef.current = { type: 'group', group, position: 'inside' }
          setBookmarkDrop(null)
          setGroupDrop({ group, position: 'inside' })
          return
        }
      } else {
        const groupElement = target?.closest<HTMLElement>('[data-group-name]')
        if (groupElement?.dataset.groupName !== undefined && groupElement.dataset.groupName !== current.value) {
          const group = groupElement.dataset.groupName
          const bounds = groupElement.getBoundingClientRect()
          const position = moveEvent.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
          sidebarPointerDropRef.current = { type: 'group', group, position }
          setGroupDrop({ group, position })
          return
        }
      }
      sidebarPointerDropRef.current = null
      setBookmarkDrop(null)
      setGroupDrop(null)
    }

    const finish = (finishEvent: PointerEvent, commit: boolean): void => {
      const current = sidebarPointerDragRef.current
      if (!current || finishEvent.pointerId !== current.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      document.body.classList.remove('sidebar-item-dragging')
      const drop = sidebarPointerDropRef.current
      sidebarPointerDragRef.current = null
      sidebarPointerDropRef.current = null
      finishSidebarDrag()
      if (!current.active) return
      suppressSidebarClickRef.current = true
      window.setTimeout(() => { suppressSidebarClickRef.current = false }, 0)
      if (!commit || !drop) return
      if (current.type === 'bookmark') {
        if (drop.type === 'bookmark') void moveBookmark(current.value, drop.group, drop.id, drop.position)
        else void moveBookmark(current.value, drop.group)
      } else if (drop.type === 'group') void reorderBookmarkGroup(current.value, drop.group, drop.position === 'inside' ? 'after' : drop.position)
    }
    const up = (upEvent: PointerEvent): void => finish(upEvent, true)
    const cancel = (cancelEvent: PointerEvent): void => finish(cancelEvent, false)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const openSidebarContextMenu = (event: React.MouseEvent, options: Omit<SidebarContextMenu, 'x' | 'y'> = {}): void => {
    event.preventDefault()
    event.stopPropagation()
    if (options.bookmark) setSelectedBookmarkId(options.bookmark.id)
    setSidebarContextMenu({ x: Math.max(4, Math.min(event.clientX, window.innerWidth - 210)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 340)), ...options })
  }

  const saveGroup = async (name: string): Promise<void> => {
    if (!groupDialog) return
    try {
      if (groupDialog.mode === 'create') setBookmarkGroupNames(await window.api.bookmarkGroups.create(name))
      else {
        const oldGroup = groupDialog.group ?? ''
        setBookmarkGroupNames(await window.api.bookmarkGroups.rename(oldGroup, name))
        setCollapsedBookmarkGroups((current) => {
          if (!current.has(oldGroup)) return current
          const next = new Set(current)
          next.delete(oldGroup)
          next.add(name.trim())
          void window.api.state.setCollapsedBookmarkGroups([...next]).catch((error) => showError(errorMessage(error)))
          return next
        })
        await reloadBookmarks()
      }
      setGroupDialog(null)
    } catch (error) { showError(errorMessage(error)) }
  }

  const duplicateBookmark = async (bookmark: Bookmark): Promise<void> => {
    try {
      const duplicate = await window.api.bookmarks.duplicate(bookmark.id)
      await reloadBookmarks()
      setBookmarkDialog(duplicate)
    } catch (error) { showError(errorMessage(error)) }
  }

  const connect = async (bookmark: Bookmark, credentials: ConnectionCredentials = {}, target: ConnectionTarget = {}): Promise<void> => {
    let key = target.tabKey ?? (target.newSession ? undefined : tabs.find((tab) => tab.bookmarkId === bookmark.id)?.key)
    if (!key) { key = crypto.randomUUID(); setTabs((current) => [...current, { key: key!, bookmarkId: bookmark.id, status: 'connecting' }]) }
    else setTabs((current) => current.map((tab) => tab.key === key ? { ...tab, sessionId: undefined, status: 'connecting', error: undefined } : tab))
    setActiveKey(key); setAuthRequest(null)
    try {
      const summary = await window.api.sessions.connect({ bookmarkId: bookmark.id, newSession: target.newSession, ...credentials })
      setTabs((current) => current.map((tab) => tab.key === key ? { ...tab, sessionId: summary.id, status: summary.status, error: undefined } : tab))
      if (credentials.rememberCredential || credentials.rememberJumpCredential) await reloadBookmarks()
    } catch (error) {
      setTabs((current) => current.map((tab) => tab.key === key ? { ...tab, status: 'error', error: errorMessage(error) } : tab))
      showError(errorMessage(error))
    }
  }

  const openBookmark = (bookmark: Bookmark, target: ConnectionTarget = {}): void => {
    const requestedTab = target.tabKey ? tabs.find((tab) => tab.key === target.tabKey) : undefined
    if (requestedTab && ['connected', 'connecting'].includes(requestedTab.status)) { setActiveKey(requestedTab.key); return }
    const existing = target.newSession ? undefined : requestedTab ?? tabs.find((tab) => tab.bookmarkId === bookmark.id && ['connected', 'connecting'].includes(tab.status)) ?? tabs.find((tab) => tab.bookmarkId === bookmark.id)
    if (!target.tabKey && (existing?.status === 'connected' || existing?.status === 'connecting')) { setActiveKey(existing.key); return }
    const jumpBookmark = bookmark.jumpBookmarkId ? bookmarkMap.get(bookmark.jumpBookmarkId) : undefined
    const hasOtherActiveSession = Boolean(target.tabKey && tabs.some((tab) => tab.key !== target.tabKey && tab.bookmarkId === bookmark.id && ['connected', 'connecting'].includes(tab.status)))
    const connectionTarget = target.tabKey ? { ...target, newSession: target.newSession ?? hasOtherActiveSession } : { ...target, tabKey: existing?.key }
    const needsPrompt = (item: Bookmark): boolean => item.authType === 'privateKey' || (item.authType === 'password' && !item.hasSavedCredential)
    if (!needsPrompt(bookmark) && (!jumpBookmark || !needsPrompt(jumpBookmark))) void connect(bookmark, {}, connectionTarget)
    else setAuthRequest({ bookmark, target: connectionTarget })
  }

  const openBookmarkFromSidebar = (bookmark: Bookmark): void => {
    const hasActiveSession = tabs.some((tab) => tab.bookmarkId === bookmark.id && ['connected', 'connecting'].includes(tab.status))
    openBookmark(bookmark, hasActiveSession ? { newSession: true } : {})
  }

  const tabLabel = (tab: WorkspaceTab, bookmark?: Bookmark): string => {
    const matchingTabs = tabs.filter((item) => item.bookmarkId === tab.bookmarkId)
    if (matchingTabs.length < 2) return bookmark?.name ?? t('common.deletedConnection')
    return `${bookmark?.name ?? t('common.deletedConnection')} ${matchingTabs.findIndex((item) => item.key === tab.key) + 1}`
  }

  const closeTab = (tab: WorkspaceTab): void => {
    if (tab.sessionId) void window.api.sessions.disconnect(tab.sessionId).catch((error) => showError(errorMessage(error)))
    setTabs((current) => {
      const index = current.findIndex((item) => item.key === tab.key)
      const next = current.filter((item) => item.key !== tab.key)
      if (activeKey === tab.key) setActiveKey(next[Math.min(index, next.length - 1)]?.key ?? '')
      return next
    })
  }

  const removeBookmark = async (bookmark: Bookmark): Promise<void> => {
    if (!await confirmAction({ title: t('common.deleteConnection'), message: t('app.deleteValue', { value0: bookmark.name }), detail: t('app.relatedOpenSessionsWillAlsoCloseThisCannot'), kind: 'danger', confirmLabel: t('common.deleteConnection') })) return
    try {
      await window.api.bookmarks.remove(bookmark.id)
      for (const tab of tabs.filter((item) => item.bookmarkId === bookmark.id)) closeTab(tab)
      setSelectedBookmarkId((current) => current === bookmark.id ? '' : current)
      await reloadBookmarks()
    } catch (error) { showError(errorMessage(error)) }
  }

  const deleteBookmarkGroup = async (group: string): Promise<void> => {
    const label = group || t('common.ungrouped')
    const count = bookmarks.filter((bookmark) => bookmark.groupName === group).length
    if (!await confirmAction({ title: t('app.deleteGroup'), message: t('app.deleteGroupValue', { value0: label }), detail: t('app.valueConnectionsInThisGroupWillAlsoBe', { value0: count }), kind: 'danger', confirmLabel: t('common.deleteGroupAndConnections') })) return
    try {
      const result = await window.api.bookmarkGroups.delete(group)
      const deleted = new Set(result.deletedBookmarkIds)
      for (const tab of tabs.filter((item) => deleted.has(item.bookmarkId))) closeTab(tab)
      setBookmarkGroupNames(result.groups)
      setBookmarks((current) => current.filter((bookmark) => !deleted.has(bookmark.id)))
      setSelectedBookmarkId((current) => deleted.has(current) ? '' : current)
      setCollapsedBookmarkGroups((current) => {
        if (!current.has(group)) return current
        const next = new Set(current)
        next.delete(group)
        void window.api.state.setCollapsedBookmarkGroups([...next]).catch((error) => showError(errorMessage(error)))
        return next
      })
    } catch (error) { showError(errorMessage(error)) }
  }

  const retryTransfer = async (task: TransferTask): Promise<void> => {
    if (!task.bookmarkId) { showError(t('app.thisLegacyTransferHasNoConnectionInformationAnd')); return }
    const tab = tabs.find((item) => item.bookmarkId === task.bookmarkId && item.status === 'connected' && item.sessionId)
    if (!tab?.sessionId) {
      const bookmark = bookmarkMap.get(task.bookmarkId)
      const existing = tabs.find((item) => item.bookmarkId === task.bookmarkId)
      if (existing) setActiveKey(existing.key)
      else if (bookmark) openBookmark(bookmark)
      showError(t('app.connectToTheHostForThisTransferThen'))
      return
    }
    try { await window.api.transfers.retry(task.id, tab.sessionId) }
    catch (error) { showError(errorMessage(error)) }
  }

  const cancelTransfer = async (task: TransferTask): Promise<void> => {
    try { await window.api.transfers.cancel(task.id) }
    catch (error) { showError(errorMessage(error)) }
  }

  const clearTransferHistory = async (): Promise<void> => {
    try {
      const deleted = new Set(await window.api.transfers.clearHistory())
      setTransfers((current) => current.filter((item) => !deleted.has(item.id)))
    } catch (error) { showError(errorMessage(error)) }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'F1' && !document.querySelector('.modal-backdrop, .help-backdrop')) {
        event.preventDefault()
        event.stopPropagation()
        setHelpDialog(true)
        return
      }
      if (document.querySelector('.modal-backdrop, .help-backdrop')) return
      const commandKey = window.api.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (commandKey && event.shiftKey && event.key.toLowerCase() === 't' && activeBookmark) {
        event.preventDefault()
        event.stopPropagation()
        openBookmark(activeBookmark, { newSession: true })
        return
      }
      if (commandKey && !event.shiftKey && event.key.toLowerCase() === 'w' && activeTab) {
        event.preventDefault()
        event.stopPropagation()
        closeTab(activeTab)
        return
      }
      if (event.ctrlKey && event.key === 'Tab' && tabs.length > 1) {
        event.preventDefault()
        event.stopPropagation()
        const index = tabs.findIndex((tab) => tab.key === activeKey)
        const offset = event.shiftKey ? -1 : 1
        setActiveKey(tabs[(index + offset + tabs.length) % tabs.length]!.key)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activeBookmark, activeTab, activeKey, tabs])

  const statusText: Record<SessionStatus, string> = { connecting: t('app.connecting'), connected: t('app.connected'), disconnected: t('app.disconnected'), error: t('app.connectionFailed') }

  const saveSettings = async (settings: TerminalSettings, previewImage: string, appIcon: AppIconId, theme: UiTheme, appLanguage: AppLanguage, ai: AiSettingsInput): Promise<void> => {
    try {
      const terminalChanged = JSON.stringify(settings) !== JSON.stringify(terminalSettings)
      const themeChanged = theme !== uiTheme
      const languageChanged = appLanguage !== savedLanguage
      const iconChanged = appIcon !== appIcons.selected
      const aiChanged = ai.baseUrl !== aiSettings.baseUrl || ai.model !== aiSettings.model || ai.defaultShell !== aiSettings.defaultShell || ai.provider !== aiSettings.provider || ai.thinkingMode !== aiSettings.thinkingMode || Boolean(ai.apiKey)
      const [saved, savedTheme, savedAppLanguage, selected, savedAi] = await Promise.all([
        terminalChanged ? window.api.settings.saveTerminal(settings) : Promise.resolve(terminalSettings),
        themeChanged ? window.api.settings.saveUiTheme(theme) : Promise.resolve(uiTheme),
        languageChanged ? window.api.settings.saveLanguage(appLanguage, getNativeMenuLabels(appLanguage)) : Promise.resolve(savedLanguage),
        iconChanged ? window.api.settings.setAppIcon(appIcon) : Promise.resolve(appIcons.selected),
        aiChanged ? window.api.ai.saveSettings(ai) : Promise.resolve(aiSettings),
      ])
      let image = saved.backgroundImagePath === settings.backgroundImagePath ? previewImage : ''
      if (saved.backgroundImagePath && !image) image = await window.api.settings.loadTerminalBackground(saved.backgroundImagePath)
      setTerminalSettings(saved)
      setUiTheme(savedTheme)
      setSavedLanguage(savedAppLanguage)
      setLanguage(savedAppLanguage)
      setUiThemePreview(null)
      setTerminalBackground(image)
      setAppIcons((current) => ({ ...current, selected }))
      setAiSettings(savedAi)
      setSettingsDialog(false)
    } catch (error) { setLanguage(savedLanguage); showError(errorMessage(error)) }
  }

  const selectedAppIcon = appIcons.options.find((item) => item.id === appIcons.selected)
  const activeThemeMode = uiThemePreview ?? uiTheme
  const resolvedUiTheme = activeThemeMode === 'system' ? systemDark ? 'dark' : 'light' : activeThemeMode

  const chooseSshConfig = async (): Promise<void> => {
    try {
      const preview = await window.api.bookmarks.previewSshConfig()
      if (preview) setImportPreview(preview)
    } catch (error) { showError(errorMessage(error)) }
  }

  useEffect(() => window.api.onEvent((event) => {
    if (event.type !== 'menu-command') return
    const modalOpen = Boolean(document.querySelector('.modal-backdrop, .help-backdrop'))
    if (modalOpen) return
    if (event.payload === 'new-connection') setBookmarkDialog('new')
    else if (event.payload === 'import-connections') void chooseSshConfig()
    else if (event.payload === 'new-session' && activeBookmark) openBookmark(activeBookmark, { newSession: true })
    else if (event.payload === 'close-tab' && activeTab) closeTab(activeTab)
    else if (event.payload === 'settings') openSettings()
    else if (event.payload === 'help') setHelpDialog(true)
    else if (event.payload === 'show-terminal' && tabs.length) setWorkspaceView('terminal')
    else if (event.payload === 'show-files' && tabs.length) setWorkspaceView('files')
    else if (event.payload === 'toggle-sidebar') setSidebarCollapsed((collapsed) => !collapsed)
  }), [activeBookmark, activeTab, tabs, bookmarks])

  const saveSidebarWidth = (width: number): void => {
    const next = clampSidebarWidth(width)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
    void window.api.state.setSidebarWidth(next).catch((error) => showError(errorMessage(error)))
  }

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidthRef.current
    document.body.classList.add('sidebar-resizing')
    const move = (moveEvent: PointerEvent): void => {
      const next = clampSidebarWidth(startWidth + moveEvent.clientX - startX)
      sidebarWidthRef.current = next
      setSidebarWidth(next)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('sidebar-resizing')
      void window.api.state.setSidebarWidth(sidebarWidthRef.current).catch((error) => showError(errorMessage(error)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const resizeSidebarWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') saveSidebarWidth(minSidebarWidth)
    else if (event.key === 'End') saveSidebarWidth(maxSidebarWidth)
    else saveSidebarWidth(sidebarWidth + (event.key === 'ArrowLeft' ? -10 : 10))
  }
  const exportConnectionArchive = async (): Promise<void> => {
    try {
      const path = await window.api.bookmarks.exportArchive()
      if (path) showToast(t('app.connectionBackupExportedValue', { value0: path }), 'success')
    } catch (error) { showError(errorMessage(error)) }
  }
  const importConnectionArchive = async (): Promise<void> => {
    try {
      const result = await window.api.bookmarks.importArchive()
      if (!result) return
      await reloadSidebarData()
      showToast(t('app.importedValueConnectionsAndValueNewGroupsCredentials', { value0: result.importedConnections, value1: result.importedGroups }), 'success')
    } catch (error) { showError(errorMessage(error)) }
  }

  const contextBookmark = sidebarContextMenu?.bookmark ?? selectedBookmark

  return <div className={`app-shell platform-${window.api.platform}`} data-theme={resolvedUiTheme} data-theme-mode={activeThemeMode}>
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="app-brand">{selectedAppIcon ? <img className="app-logo" src={selectedAppIcon.dataUrl} alt="" /> : <span className="app-logo app-logo-fallback">&gt;_</span>}<span>Luna Remote</span></div>
      <span className="titlebar-spacer" />
      <button className="icon-button titlebar-help" title={t('app.helpF1')} aria-label={t('app.help')} onClick={() => setHelpDialog(true)}><CircleHelp size={18} /></button>
      <button className="icon-button titlebar-settings" title={t('common.settings')} aria-label={t('common.settings')} onClick={() => openSettings()}><SettingsIcon size={18} /></button>
      <div className="window-controls">
        <button className="window-control" title={t('common.minimize')} aria-label={t('common.minimize')} onClick={() => void window.api.system.minimizeWindow().catch((error) => showError(errorMessage(error)))}><Minus size={16} /></button>
        <button className="window-control" title={t('common.maximizeOrRestore')} aria-label={t('common.maximizeOrRestore')} onClick={() => void window.api.system.toggleMaximizeWindow().catch((error) => showError(errorMessage(error)))}><Square size={13} /></button>
        <button className="window-control close" title={t('common.close')} aria-label={t('common.close')} onClick={() => void window.api.system.closeWindow().catch((error) => showError(errorMessage(error)))}><X size={17} /></button>
      </div>
    </header>
    <div className={`main-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <aside className="sidebar" onContextMenu={(event) => openSidebarContextMenu(event)}>
        <div className="sidebar-heading"><strong>{t('app.connections')}</strong><div className="sidebar-actions">
          <button className="icon-button" title={t('common.newConnection')} onClick={() => setBookmarkDialog('new')}><CirclePlus size={18} /></button>
          <button className="icon-button" title={t('app.deleteSelectedConnection')} disabled={!selectedBookmark} onClick={() => selectedBookmark && void removeBookmark(selectedBookmark)}><Trash2 size={17} /></button>
        </div></div>
        <label className="search-box"><Search size={16} /><input placeholder={t('app.searchConnections')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="bookmark-list">
          {query && filteredBookmarks.length === 0 && <div className="sidebar-empty"><BookmarkIcon size={24} /><span>{t('app.noMatchingConnections')}</span></div>}
          {bookmarkGroups.flatMap(([group, items]) => {
            const collapsed = !query && collapsedBookmarkGroups.has(group)
            const groupDropClass = groupDrop?.group === group ? `drop-${groupDrop.position}` : ''
            return [<button type="button" data-group-name={group} className={`bookmark-group ${draggedGroupName === group ? 'dragging' : ''} ${groupDropClass}`} key={`group:${group}`} aria-expanded={!collapsed} onPointerDown={(event) => startSidebarPointerDrag(event, 'group', group)} onClick={(event) => { if (suppressSidebarClickRef.current) { event.preventDefault(); return } toggleBookmarkGroup(group) }} onContextMenu={(event) => openSidebarContextMenu(event, { group })}>
              <span className="group-drag-handle" title={query ? t('common.clearTheSearchToReorder') : t('app.dragToReorderGroup')}><GripVertical size={13} /></span>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}<span>{group || t('common.ungrouped')}</span><small>{items.length}</small>
            </button>, ...(collapsed ? [] : items.map((bookmark) => {
            const tab = tabs.find((item) => item.bookmarkId === bookmark.id)
            const jumpBookmark = bookmark.jumpBookmarkId ? bookmarkMap.get(bookmark.jumpBookmarkId) : undefined
            const dropClass = bookmarkDrop?.id === bookmark.id ? `drop-${bookmarkDrop.position}` : ''
            return <button key={bookmark.id} data-bookmark-id={bookmark.id} className={`bookmark-item ${selectedBookmark?.id === bookmark.id ? 'active' : ''} ${draggedBookmarkId === bookmark.id ? 'dragging' : ''} ${dropClass}`} onPointerDown={(event) => startSidebarPointerDrag(event, 'bookmark', bookmark.id)} onClick={(event) => { if (suppressSidebarClickRef.current) { event.preventDefault(); return } setSelectedBookmarkId(bookmark.id) }} onDoubleClick={(event) => { if (suppressSidebarClickRef.current) { event.preventDefault(); return } openBookmarkFromSidebar(bookmark) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setSelectedBookmarkId(bookmark.id); openBookmarkFromSidebar(bookmark) } }} onContextMenu={(event) => openSidebarContextMenu(event, { bookmark })}>
              <span className="bookmark-drag-handle" title={query ? t('common.clearTheSearchToReorder') : t('app.dragToReorder')}><GripVertical size={14} /></span>
              <span className={`server-icon ${tab?.status ?? 'disconnected'}`}><Server size={17} /></span>
              <span className="bookmark-copy"><strong>{bookmark.name}</strong><small title={jumpBookmark ? t('app.viaValue', { value0: jumpBookmark.name }) : undefined}>{bookmark.username}@{bookmark.host}:{bookmark.port}{jumpBookmark ? t('common.viaValue', { value0: jumpBookmark.name }) : ''}</small></span>
              <span className="bookmark-flags">{bookmark.favorite && <Star size={12} className="favorite-star" fill="currentColor" />}{bookmark.hasSavedCredential && <KeyRound size={12} className="saved-key" />}</span>
            </button>
          }))]})}
        </div>
      </aside>
      <div className="sidebar-resizer" role="separator" aria-label={t('app.resizeSidebar')} aria-orientation="vertical" aria-valuemin={minSidebarWidth} aria-valuemax={maxSidebarWidth} aria-valuenow={sidebarWidth} tabIndex={0} title={t('app.dragToResizeDoubleClickToReset')} onPointerDown={startSidebarResize} onDoubleClick={() => saveSidebarWidth(defaultSidebarWidth)} onKeyDown={resizeSidebarWithKeyboard} />
      <main className={`workspace ${tabs.length && workspaceView === 'files' ? 'file-mode' : ''}`}>
        <div className="tabbar">
          <button className="icon-button tab-sidebar-toggle" title={sidebarCollapsed ? t('common.showConnections') : t('common.hideConnections')} aria-label={sidebarCollapsed ? t('common.showConnections') : t('common.hideConnections')} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          {tabs.map((tab) => { const bookmark = bookmarkMap.get(tab.bookmarkId); const label = tabLabel(tab, bookmark); const endpoint = bookmark ? `${bookmark.username}@${bookmark.host}:${bookmark.port}` : ''; return <div key={tab.key} className={`session-tab ${tab.key === activeKey ? 'active' : ''}`}>
            <button className="session-tab-select" title={bookmark ? `${label} · ${endpoint}` : label} onClick={() => setActiveKey(tab.key)} onAuxClick={(event) => { if (event.button === 1) closeTab(tab) }}><span className={`status-dot ${tab.status}`} /><span title={label}>{label}</span></button>
            <button className="session-tab-close" title={t('app.closeSession')} aria-label={t('app.closeNamedSession', { name: bookmark?.name ?? t('common.session') })} onClick={() => closeTab(tab)}><X size={14} /></button>
          </div> })}
          <button className="icon-button tab-add" title={t('common.newConnection')} onClick={() => setBookmarkDialog('new')}><CirclePlus size={17} /></button>
        </div>
        {tabs.length === 0 ? <div className="welcome-state"><div className="welcome-icon"><Plug size={30} /></div><h2>{t('app.chooseAnSshConnection')}</h2><p>{t('app.useTheTerminalAndSftpFileTransfersIn')}</p><button className="primary-button" onClick={() => setBookmarkDialog('new')}><CirclePlus size={16} />{t('common.newConnection')}</button></div> : <>
          <div className="session-toolbar"><div className="session-info"><span className={`status-dot ${activeTab?.status}`} /><span className="session-status">{activeTab ? statusText[activeTab.status] : ''}</span>{activeBookmark && <span className="session-endpoint" title={`${activeBookmark.username}@${activeBookmark.host}:${activeBookmark.port}`}>{activeBookmark.username}@{activeBookmark.host}:{activeBookmark.port}</span>}{activeTab?.error && <span className="error-text" title={activeTab.error}>{activeTab.error}</span>}</div>
            <div className="view-switcher" role="tablist" aria-label={t('app.sessionView')}>
              <button role="tab" title={t('common.terminal')} aria-selected={workspaceView === 'terminal'} className={workspaceView === 'terminal' ? 'active' : ''} onClick={() => setWorkspaceView('terminal')}><SquareTerminal size={15} />{t('common.terminal')}</button>
              <button role="tab" title={t('app.files')} aria-selected={workspaceView === 'files'} className={workspaceView === 'files' ? 'active' : ''} onClick={() => setWorkspaceView('files')}><FolderOpen size={15} />{t('app.files')}</button>
            </div><div className="session-actions">
            {workspaceView === 'files' && activeBookmark && activeTab?.sessionId && <button className="secondary-button" title={t('app.deploy')} onClick={() => setDeploymentDialog(true)}><Rocket size={15} />{t('app.deploy')}</button>}
            {workspaceView === 'terminal' && activeBookmark && <button className="secondary-button" title={t('app.aiCommand')} onClick={() => setAiDialog(true)}><WandSparkles size={15} />{t('app.aiCommand')}</button>}
            {activeTab?.status === 'connected' && activeTab.sessionId && <button className="secondary-button" title={t('app.portForwarding')} onClick={() => setTunnelDialog(true)}><Network size={15} />{t('app.portForwarding')}</button>}
            {activeTab?.status === 'connected' && <button className="secondary-button" title={t('app.disconnect')} onClick={() => activeTab.sessionId && void window.api.sessions.disconnect(activeTab.sessionId).catch((error) => showError(errorMessage(error)))}><Power size={15} />{t('app.disconnect')}</button>}
          </div></div>
          <div className="session-stack">
            {tabs.map((tab) => { const bookmark = bookmarkMap.get(tab.bookmarkId); const reconnect = bookmark ? () => openBookmark(bookmark, { tabKey: tab.key }) : undefined; return <div key={tab.key} className={`session-view ${tab.key === activeKey ? 'active' : ''} ${workspaceView}`}>
              <div className="terminal-region"><TerminalPane ref={(pane) => { if (pane) terminalPaneRefs.current.set(tab.key, pane); else terminalPaneRefs.current.delete(tab.key) }} sessionId={tab.sessionId} connected={tab.status === 'connected'} visible={tab.key === activeKey && workspaceView === 'terminal'} settings={terminalSettings} backgroundImage={terminalBackground} onConnect={reconnect} onOpenSettings={() => openSettings('terminal')} /></div>
              <div className="sftp-region"><SftpPane sessionId={tab.sessionId} bookmarkId={tab.bookmarkId} connected={tab.status === 'connected'} visible={tab.key === activeKey && workspaceView === 'files'} onError={showError} onConnect={reconnect} /></div>
            </div> })}
          </div>
        </>}
        {tabs.length > 0 && workspaceView === 'files' && <TransferPanel transfers={transfers} view={transferView} setView={setTransferView} onRetry={(task) => void retryTransfer(task)} onCancel={(task) => void cancelTransfer(task)} onClear={() => void clearTransferHistory()} />}
      </main>
    </div>
    {sidebarContextMenu && <div className="sidebar-context-menu" role="menu" style={{ left: sidebarContextMenu.x, top: sidebarContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
      {sidebarContextMenu.group !== undefined ? <>
        <button role="menuitem" onClick={() => { setSidebarContextMenu(null); setGroupDialog({ mode: 'create' }) }}><FolderPlus size={15} />{t('common.newGroup')}</button>
        <button role="menuitem" onClick={() => { const group = sidebarContextMenu.group ?? ''; setSidebarContextMenu(null); setGroupDialog({ mode: 'rename', group }) }}><Edit3 size={15} />{t('common.renameGroup')}</button>
        <button role="menuitem" className="danger" onClick={() => { const group = sidebarContextMenu.group ?? ''; setSidebarContextMenu(null); void deleteBookmarkGroup(group) }}><Trash2 size={15} />{t('common.deleteGroupAndConnections')}</button>
      </> : <>
        <button role="menuitem" onClick={() => { setSidebarContextMenu(null); void chooseSshConfig() }}><FileInput size={15} />{t('common.importOpensshConfig')}</button>
        <button role="menuitem" onClick={() => { setSidebarContextMenu(null); void importConnectionArchive() }}><Upload size={15} />{t('app.importConnectionBackup')}</button>
        <button role="menuitem" onClick={() => { setSidebarContextMenu(null); void exportConnectionArchive() }}><Download size={15} />{t('app.exportConnectionBackup')}</button>
        <div className="context-menu-separator" />
        <button role="menuitem" onClick={() => { setSidebarContextMenu(null); setBookmarkDialog('new') }}><CirclePlus size={15} />{t('common.newConnection')}</button>
        <button role="menuitem" disabled={!contextBookmark} onClick={() => { setSidebarContextMenu(null); if (contextBookmark) setBookmarkDialog(contextBookmark) }}><Edit3 size={15} />{t('common.editConnection')}</button>
        <button role="menuitem" disabled={!contextBookmark} onClick={() => { setSidebarContextMenu(null); if (contextBookmark) void duplicateBookmark(contextBookmark) }}><Copy size={15} />{t('app.duplicate')}</button>
        <button role="menuitem" disabled={!contextBookmark} className="danger" onClick={() => { setSidebarContextMenu(null); if (contextBookmark) void removeBookmark(contextBookmark) }}><Trash2 size={15} />{t('common.deleteConnection')}</button>
        <div className="context-menu-separator" />
        <button role="menuitem" onClick={() => { setSidebarContextMenu(null); setGroupDialog({ mode: 'create' }) }}><FolderPlus size={15} />{t('common.newGroup')}</button>
      </>}
    </div>}
    {groupDialog && <GroupNameDialog mode={groupDialog.mode} initialName={groupDialog.group ?? ''} onClose={() => setGroupDialog(null)} onSave={(name) => void saveGroup(name)} />}
    {bookmarkDialog && <BookmarkDialog bookmark={bookmarkDialog === 'new' ? undefined : bookmarkDialog} connections={bookmarks} groups={bookmarkGroupNames} onClose={() => setBookmarkDialog(null)} onSaved={async () => { setBookmarkDialog(null); await reloadSidebarData() }} onError={showError} />}
    {authRequest && <AuthDialog bookmark={authRequest.bookmark} jumpBookmark={authRequest.bookmark.jumpBookmarkId ? bookmarkMap.get(authRequest.bookmark.jumpBookmarkId) : undefined} onClose={() => setAuthRequest(null)} onConnect={(credentials) => void connect(authRequest.bookmark, credentials, authRequest.target)} />}
    {hostPrompts[0] && <HostKeyDialog prompt={hostPrompts[0]} onDecision={(accept) => { const prompt = hostPrompts[0]; if (!prompt) return; window.api.sessions.hostKeyDecision(prompt.sessionId, accept); setHostPrompts((current) => current.filter((item) => item !== prompt)) }} />}
    {conflict && <ConflictDialog conflict={conflict} onDecision={(resolution, apply) => { window.api.transfers.resolveConflict(conflict.taskId, resolution, apply); setConflict(null) }} />}
    {settingsDialog && <SettingsDialog initialSection={settingsInitialSection} settings={terminalSettings} backgroundImage={terminalBackground} appIcons={appIcons} uiTheme={uiTheme} appLanguage={savedLanguage} aiSettings={aiSettings} onAiSettingsChange={setAiSettings} onThemePreview={setUiThemePreview} onLanguagePreview={setLanguage} onClose={() => { setUiThemePreview(null); setLanguage(savedLanguage); setSettingsDialog(false) }} onSave={(settings, image, icon, theme, appLanguage, ai) => void saveSettings(settings, image, icon, theme, appLanguage, ai)} onConfirm={confirmAction} onNotice={(message) => showToast(message, 'success')} onError={showError} raised={deploymentDialog} />}
    {aiDialog && activeBookmark && activeTab && <AiCommandDialog bookmark={activeBookmark} sessionId={activeTab.sessionId} connected={activeTab.status === 'connected'} settings={aiSettings} getTerminalContext={() => terminalPaneRefs.current.get(activeTab.key)?.getRecentLines(aiTerminalContextLines, aiTerminalContextChars) ?? ''} onSettingsChange={setAiSettings} onSettings={() => { setAiDialog(false); openSettings('ai') }} onClose={() => setAiDialog(false)} onError={showError} />}
    {helpDialog && <HelpDialog onClose={() => setHelpDialog(false)} />}
    {deploymentDialog && activeBookmark && activeTab?.sessionId && <DeploymentDialog bookmark={activeBookmark} sessionId={activeTab.sessionId} aiSettings={aiSettings} onOpenAiSettings={() => openSettings('ai')} onClose={() => setDeploymentDialog(false)} onConfirm={confirmAction} onNotice={(message) => showToast(message, 'success')} onError={showError} />}
    {tunnelDialog && activeBookmark && activeTab?.sessionId && <TunnelDialog bookmark={activeBookmark} sessionId={activeTab.sessionId} onClose={() => setTunnelDialog(false)} onError={showError} />}
    {importPreview && <SshConfigImportDialog preview={importPreview} onClose={() => setImportPreview(null)} onImported={async () => { setImportPreview(null); await reloadSidebarData() }} onError={showError} />}
    {confirmation && <ConfirmationDialog confirmation={confirmation} onDecision={resolveConfirmation} />}
    {toast && <div className={`toast ${toastKind}`}>{toast}</div>}
  </div>
}

function AiCommandDialog({ bookmark, sessionId, connected, settings, getTerminalContext, onSettingsChange, onSettings, onClose, onError }: { bookmark: Bookmark; sessionId?: string; connected: boolean; settings: AiSettings; getTerminalContext(): string; onSettingsChange(settings: AiSettings): void; onSettings(): void; onClose(): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const [requirement, setRequirement] = useState('')
  const [shell, setShell] = useState<AiShell>(settings.defaultShell)
  const [suggestion, setSuggestion] = useState<AiCommandSuggestion | null>(null)
  const [command, setCommand] = useState('')
  const [edited, setEdited] = useState(false)
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState<AiRiskAssessment | null>(null)
  const [confirmationText, setConfirmationText] = useState('')
  const [includeTerminalContext, setIncludeTerminalContext] = useState(false)
  const [redactTerminalContext, setRedactTerminalContext] = useState(true)
  const [rawExchange, setRawExchange] = useState<AiRawExchange | null>(null)
  const [history, setHistory] = useState<AiCommandHistoryEntry[] | null>(null)

  const effectiveAssessment = (local: AiRiskAssessment): AiRiskAssessment => {
    if (!suggestion || edited) return local
    const rank = { low: 0, medium: 1, high: 2 } as const
    const riskLevel = rank[suggestion.riskLevel] > rank[local.riskLevel] ? suggestion.riskLevel : local.riskLevel
    return { riskLevel, warnings: [...new Set([...suggestion.warnings, ...local.warnings])] }
  }

  const selectShell = async (value: AiShell): Promise<void> => {
    setShell(value)
    try {
      const saved = await window.api.ai.saveSettings({ baseUrl: settings.baseUrl, model: settings.model, defaultShell: value, provider: settings.provider, thinkingMode: settings.thinkingMode })
      onSettingsChange(saved)
    } catch (saveError) { onError(errorMessage(saveError)) }
  }
  const generate = async (): Promise<void> => {
    if (!requirement.trim()) return
    const terminalContext = includeTerminalContext ? getTerminalContext() : undefined
    if (includeTerminalContext && !terminalContext?.trim()) { setError(t('app.theCurrentTerminalHasNoTextToInclude')); return }
    setLoading(true); setError(''); setSuggestion(null); setCommand(''); setEdited(false)
    try {
      const result = await window.api.ai.generate(requirement.trim(), shell, terminalContext, includeTerminalContext && redactTerminalContext)
      setSuggestion(result); setCommand(result.command)
    } catch (generateError) { setError(errorMessage(generateError)) }
    finally { setLoading(false) }
  }
  const requireConnectedSession = (): string | null => {
    if (!connected || !sessionId) { setError(t('app.theSshSessionIsDisconnectedAndCannotReceive')); return null }
    return sessionId
  }
  const fillCommand = async (): Promise<void> => {
    const targetSession = requireConnectedSession()
    if (!targetSession) return
    try {
      const assessment = effectiveAssessment(await window.api.ai.analyze(command))
      setSuggestion((current) => current ? { ...current, riskLevel: assessment.riskLevel, warnings: assessment.warnings } : current)
      await window.api.sessions.writeCommand(targetSession, command.trim())
      onClose()
    } catch (fillError) { setError(errorMessage(fillError)) }
  }
  const executeConfirmed = async (): Promise<void> => {
    const targetSession = requireConnectedSession()
    if (!targetSession) return
    setExecuting(true)
    try {
      await window.api.ai.analyze(command)
      await window.api.sessions.writeCommand(targetSession, `${command.trim()}\r`)
      onClose()
    } catch (executeError) { setError(errorMessage(executeError)); setConfirming(null); setExecuting(false) }
  }
  const requestExecution = async (): Promise<void> => {
    const targetSession = requireConnectedSession()
    if (!targetSession) return
    try {
      const assessment = effectiveAssessment(await window.api.ai.analyze(command))
      setSuggestion((current) => current ? { ...current, riskLevel: assessment.riskLevel, warnings: assessment.warnings } : current)
      setConfirmationText('')
      setConfirming(assessment)
    } catch (executeError) { setError(errorMessage(executeError)) }
  }
  const riskText = suggestion ? ({ low: t('common.lowRisk'), medium: t('common.caution'), high: t('common.highRisk') } as const)[suggestion.riskLevel] : ''

  const openRawExchange = async (): Promise<void> => {
    try {
      const exchange = await window.api.ai.getLastExchange()
      if (!exchange) { setError(t('app.noAiRequestDiagnosticsAreAvailable')); return }
      setRawExchange(exchange)
    } catch (diagnosticError) { setError(errorMessage(diagnosticError)) }
  }

  const openHistory = async (): Promise<void> => {
    try { setHistory(await window.api.ai.listHistory()) }
    catch (historyError) { setError(errorMessage(historyError)) }
  }

  const useHistoryEntry = (entry: AiCommandHistoryEntry): void => {
    setRequirement(entry.requirement)
    setShell(entry.shell)
    setSuggestion(entry)
    setCommand(entry.command)
    setEdited(false)
    setError('')
    setHistory(null)
  }

  if (rawExchange) return <AiDiagnosticsDialog exchange={rawExchange} onClose={() => setRawExchange(null)} onClear={async () => { try { await window.api.ai.clearLastExchange(); setRawExchange(null) } catch (clearError) { onError(errorMessage(clearError)) } }} />
  if (history) return <AiCommandHistoryDialog entries={history} onUse={useHistoryEntry} onClose={() => setHistory(null)} onClear={async () => { try { await window.api.ai.clearHistory(); setHistory([]) } catch (clearError) { onError(errorMessage(clearError)) } }} />

  const executionConfirmation = confirming ? (() => {
    const confirmationCopy = {
      low: { title: t('app.confirmCommandExecution'), heading: t('app.confirmRunningThisCommandInTheCurrentSession') },
      medium: { title: t('app.confirmCommandExecution2'), heading: t('app.thisCommandMayChangeTheSystemOrFiles') },
      high: { title: t('app.confirmHighRiskCommand'), heading: t('app.thisCommandMayCauseIrreversibleChanges') },
    } as const
    const copy = confirmationCopy[confirming.riskLevel]
    const requiresTextConfirmation = confirming.riskLevel === 'high'
    return <Modal title={copy.title} onClose={() => setConfirming(null)} raised className="secondary-confirm-dialog"><div className={`ai-execution-confirm ${confirming.riskLevel}`}>
      <div className="ai-confirm-heading">{confirming.riskLevel === 'low' ? <SquareTerminal size={22} /> : <ShieldAlert size={22} />}<div><strong>{copy.heading}</strong><span>{bookmark.username}@{bookmark.host}:{bookmark.port}</span></div></div>
      <pre>{command.trim()}</pre>
      {confirming.warnings.length > 0 && <ul>{confirming.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      {requiresTextConfirmation && <label>{t('app.typeExecuteToContinue')}<input autoFocus value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} /></label>}
      <div className="dialog-actions"><button className="secondary-button" disabled={executing} onClick={() => setConfirming(null)}>{t('common.cancel')}</button><button className={requiresTextConfirmation ? 'danger-button' : 'primary-button'} disabled={(requiresTextConfirmation && confirmationText !== t('app.execute')) || executing} onClick={() => void executeConfirmed()}><Play size={15} />{executing ? t('app.executing') : t('app.executeCommand')}</button></div>
    </div></Modal>
  })() : null

  return <><Modal title={t('app.aiCommandAssistant')} onClose={confirming ? () => undefined : onClose} wide className="workflow-dialog"><div className="ai-command-dialog">
    <div className="ai-command-content"><div className="ai-target"><Server size={16} /><strong>{bookmark.name}</strong><span>{bookmark.username}@{bookmark.host}:{bookmark.port}</span><button type="button" className="icon-button" title={t('app.recentCommands')} onClick={() => void openHistory()}><HistoryIcon size={15} /></button><button type="button" className="icon-button" title={t('app.viewRawAiRequestAndResponse')} onClick={() => void openRawExchange()}><FileJson2 size={15} /></button><span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} /></div>
    {!settings.model.trim() ? <div className="ai-unconfigured"><Bot size={28} /><strong>{t('app.noAiModelConfigured')}</strong><button className="primary-button" onClick={onSettings}><SettingsIcon size={15} />{t('app.openAiSettings')}</button></div> : <>
      <section className="ai-compose">
        <div className="ai-prompt-row"><label>{t('app.targetShell')}<select value={shell} onChange={(event) => void selectShell(event.target.value as AiShell)}><option value="linux">Linux Shell</option><option value="powerShell">PowerShell</option><option value="cmd">Windows cmd</option><option value="macos">macOS Shell</option></select></label><label className="ai-requirement">{t('app.whatDoYouNeedToDo')}<textarea autoFocus rows={4} maxLength={8000} value={requirement} onChange={(event) => setRequirement(event.target.value)} placeholder={t('app.forExampleFindAppLogEntriesWhereThe')} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void generate() } }} /></label></div>
        <div className="ai-compose-actions"><div className="ai-context-options"><label className="check-label ai-context-option" title={t('app.includeUpToValueCharactersInTheAi', { value0: aiTerminalContextChars })}><input type="checkbox" checked={includeTerminalContext} onChange={(event) => setIncludeTerminalContext(event.target.checked)} />{t('app.includeTheLastValueTerminalLines', { value0: aiTerminalContextLines })}</label><label className="check-label ai-context-option" title={t('app.maskCommonPhoneNumbersEmailAddressesAndIdentity')}><input type="checkbox" disabled={!includeTerminalContext} checked={redactTerminalContext} onChange={(event) => setRedactTerminalContext(event.target.checked)} />{t('app.redactSensitiveInformation')}</label></div><button className="primary-button" disabled={loading || !requirement.trim()} onClick={() => void generate()}><WandSparkles size={15} />{loading ? t('app.generating') : suggestion ? t('app.regenerate') : t('app.generateCommand')}</button></div>
      </section>
      {error && <div className="ai-error">{error}</div>}
      {suggestion && <div className="ai-result">
        <div className="ai-result-heading"><div><strong>{t('app.generatedResult')}</strong><span className={`ai-risk ${suggestion.riskLevel}`}>{riskText}</span></div>{edited && <span className="ai-edited">{t('app.theCommandWasEditedTheOriginalExplanationMay')}</span>}</div>
        <textarea className="ai-command-editor" rows={4} spellCheck={false} value={command} onChange={(event) => { setCommand(event.target.value); setEdited(event.target.value !== suggestion.command) }} />
        {suggestion.explanation && <p>{suggestion.explanation}</p>}
        {suggestion.assumptions.length > 0 && <details className="ai-notes"><summary>{t('app.assumptions')} <span>{suggestion.assumptions.length}</span></summary><ul>{suggestion.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
        {suggestion.warnings.length > 0 && <details className="ai-notes warning"><summary>{t('app.warnings')} <span>{suggestion.warnings.length}</span></summary><ul>{suggestion.warnings.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      </div>}
    </>}
    </div><div className="ai-command-footer"><button className="secondary-button" disabled={!command.trim()} onClick={() => void window.api.system.writeClipboard(command).catch((copyError) => setError(errorMessage(copyError)))}><Copy size={15} />{t('common.copy')}</button><div><button className="secondary-button" disabled={!connected || !command.trim() || executing} onClick={() => void fillCommand()}><Send size={15} />{t('app.insertIntoTerminal')}</button><button className="primary-button" disabled={!connected || !command.trim() || executing} onClick={() => void requestExecution()}><Play size={15} />{t('app.execute2')}</button></div></div>
  </div></Modal>{executionConfirmation}</>
}

function prettyRawJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) }
  catch { return value }
}

function AiCommandHistoryDialog({ entries, onUse, onClose, onClear }: { entries: AiCommandHistoryEntry[]; onUse(entry: AiCommandHistoryEntry): void; onClose(): void; onClear(): Promise<void> }): React.JSX.Element {
  const { t } = useI18n()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const shellNames: Record<AiShell, string> = { linux: 'Linux Shell', powerShell: 'PowerShell', cmd: 'Windows cmd', macos: 'macOS Shell' }
  const riskNames = { low: t('common.lowRisk'), medium: t('common.caution'), high: t('common.highRisk') } as const
  return <><Modal title={t('app.aiCommandHistory')} onClose={confirmingClear ? () => undefined : onClose} wide className="workflow-dialog"><div className="ai-history">
    <div className="ai-history-list">{entries.length === 0 ? <div className="ai-history-empty"><HistoryIcon size={26} /><strong>{t('app.noCommandHistory')}</strong><span>{t('app.the10MostRecentSuccessfulCommandsAppearHere')}</span></div> : entries.map((entry) => <article key={entry.id} className="ai-history-entry">
      <header><div><span>{shellNames[entry.shell]}</span><time>{new Date(entry.createdAt).toLocaleString()}</time></div><span className={`ai-risk ${entry.riskLevel}`}>{riskNames[entry.riskLevel]}</span></header>
      <p title={entry.requirement}>{entry.requirement}</p>
      <pre>{entry.command}</pre>
      <div><button className="secondary-button" onClick={() => void window.api.system.writeClipboard(entry.command)}><Copy size={15} />{t('common.copy')}</button><button className="primary-button" onClick={() => onUse(entry)}><Check size={15} />{t('app.use')}</button></div>
    </article>)}</div>
    <div className="dialog-actions spread"><button className="danger-button" disabled={entries.length === 0} onClick={() => setConfirmingClear(true)}><Trash2 size={15} />{t('common.clearHistory')}</button><button className="primary-button" onClick={onClose}>{t('common.back')}</button></div>
  </div></Modal>{confirmingClear && <Modal title={t('app.clearAiCommandHistory')} onClose={() => setConfirmingClear(false)} raised className="secondary-confirm-dialog"><div className="confirmation-dialog danger">
    <div className="confirmation-heading"><Trash2 size={22} /><div><strong>{t('app.clearAllAiCommandHistory')}</strong><span>{t('app.the10MostRecentlySavedCommandsWillBe')}</span></div></div>
    <div className="dialog-actions"><button className="secondary-button" onClick={() => setConfirmingClear(false)}>{t('common.cancel')}</button><button className="danger-button" onClick={async () => { await onClear(); setConfirmingClear(false) }}><Trash2 size={15} />{t('common.clearHistory')}</button></div>
  </div></Modal>}</>
}

function AiDiagnosticsDialog({ exchange, onClose, onClear }: { exchange: AiRawExchange; onClose(): void; onClear(): void }): React.JSX.Element {
  const { t } = useI18n()
  const [view, setView] = useState<'request' | 'response'>('response')
  const headers = view === 'request' ? exchange.requestHeaders : exchange.responseHeaders
  const body = prettyRawJson(view === 'request' ? exchange.requestBody : exchange.responseBody)
  const copy = [view === 'request' ? `POST ${exchange.endpoint}` : `HTTP ${exchange.responseStatus ?? t('common.noResponse')}`, headers, body, exchange.error && `Error: ${exchange.error}`].filter(Boolean).join('\n\n')
  return <Modal title={t('app.rawAiRequestAndResponse')} onClose={onClose} wide className="workflow-dialog"><div className="ai-diagnostics">
    <div className="ai-diagnostics-meta"><span title={exchange.endpoint}>POST {exchange.endpoint}</span><time>{new Date(exchange.occurredAt).toLocaleString()}</time>{exchange.responseStatus ? <strong className={exchange.responseStatus >= 400 ? 'error' : ''}>HTTP {exchange.responseStatus}</strong> : <strong className="error">{t('common.noResponse')}</strong>}</div>
    {exchange.error && <div className="ai-error">{exchange.error}</div>}
    <div className="ai-diagnostics-tabs" role="tablist" aria-label={t('app.rawDataType')}><button role="tab" aria-selected={view === 'request'} className={view === 'request' ? 'active' : ''} onClick={() => setView('request')}>{t('app.request')}</button><button role="tab" aria-selected={view === 'response'} className={view === 'response' ? 'active' : ''} onClick={() => setView('response')}>{t('app.response')}</button></div>
    <div className="ai-diagnostics-content">{headers && <section><strong>Headers</strong><pre>{headers}</pre></section>}<section><strong>Body</strong><pre>{body || t('app.empty')}</pre></section></div>
    <div className="dialog-actions spread"><button className="danger-button" onClick={onClear}><Trash2 size={15} />{t('app.clear')}</button><div><button className="secondary-button" onClick={() => void window.api.system.writeClipboard(copy)}><Copy size={15} />{t('common.copy')}</button><button className="primary-button" onClick={onClose}>{t('common.back')}</button></div></div>
  </div></Modal>
}

function SshConfigImportDialog({ preview, onClose, onImported, onError }: { preview: SshConfigPreview; onClose(): void; onImported(): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const [selected, setSelected] = useState(() => new Set(preview.entries.map((item) => item.alias)))
  const [loading, setLoading] = useState(false)
  const toggle = (alias: string): void => setSelected((current) => {
    const next = new Set(current)
    if (next.has(alias)) next.delete(alias); else next.add(alias)
    return next
  })
  const importSelected = async (): Promise<void> => {
    setLoading(true)
    try { await window.api.bookmarks.importSshConfig(preview.path, [...selected]); onImported() }
    catch (error) { onError(errorMessage(error)) }
    finally { setLoading(false) }
  }
  return <Modal title={t('common.importOpensshConfig')} onClose={onClose} wide><div className="ssh-import-dialog">
    <div className="import-source" title={preview.path}>{preview.path}</div>
    <div className="import-list">{preview.entries.length === 0 ? <div className="import-empty">{t('app.noConcreteHostEntriesWereFound')}</div> : preview.entries.map((entry) => <label key={entry.alias}>
      <input type="checkbox" checked={selected.has(entry.alias)} onChange={() => toggle(entry.alias)} />
      <span><strong>{entry.name}</strong><small>{entry.username}@{entry.host}:{entry.port}{entry.proxyJumpAlias ? t('common.viaValue', { value0: entry.proxyJumpAlias }) : ''}</small></span>
      <em>{entry.privateKeyPath ? t('common.privateKey') : 'Agent'}</em>
    </label>)}</div>
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" disabled={!selected.size || loading} onClick={() => void importSelected()}>{loading ? t('app.importing') : t('app.importValueConnections', { value0: selected.size })}</button></div>
  </div></Modal>
}

function TunnelDialog({ bookmark, sessionId, onClose, onError }: { bookmark: Bookmark; sessionId: string; onClose(): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const empty = (): PortForwardProfile => ({ id: crypto.randomUUID(), bookmarkId: bookmark.id, name: '', type: 'local', bindAddress: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 80 })
  const [profiles, setProfiles] = useState<PortForwardProfile[]>([])
  const [profile, setProfile] = useState<PortForwardProfile>(empty)
  const [tunnels, setTunnels] = useState<TunnelSummary[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    void Promise.all([window.api.tunnels.listProfiles(bookmark.id), window.api.tunnels.list(sessionId)]).then(([items, active]) => {
      setProfiles(items); setTunnels(active); if (items[0]) setProfile(items[0])
    }).catch((error) => onError(errorMessage(error)))
    return window.api.onEvent((event) => {
      if (event.type !== 'tunnel' || event.payload.sessionId !== sessionId) return
      setTunnels((current) => event.payload.removed ? current.filter((item) => item.id !== event.payload.id) : [event.payload, ...current.filter((item) => item.id !== event.payload.id)])
    })
  }, [bookmark.id, sessionId])
  const set = <K extends keyof PortForwardProfile>(key: K, value: PortForwardProfile[K]): void => setProfile((current) => ({ ...current, [key]: value }))
  const active = tunnels.find((item) => item.profileId === profile.id)
  const currentTarget = ['127.0.0.1', 'localhost', '::1'].includes(profile.targetHost.trim().toLowerCase())
  const bindPort = active?.bindPort ?? profile.bindPort
  const bindEndpoint = `${profile.bindAddress || t('common.notSet')}:${bindPort || t('app.auto')}`
  const targetEndpoint = profile.type === 'dynamic' ? t('app.selectedByClient') : `${profile.targetHost || t('common.notSet')}:${profile.targetPort || t('common.notSet')}`
  const route = profile.type === 'local'
    ? [{ label: t('app.localApp'), value: bindEndpoint, icon: Monitor }, { label: t('common.sshTunnel'), value: `${bookmark.host}:${bookmark.port}`, icon: Server }, { label: currentTarget ? t('common.sshServer') : t('app.hostReachableByServer'), value: targetEndpoint, icon: Network }]
    : profile.type === 'remote'
      ? [{ label: t('app.sshServerListener'), value: bindEndpoint, icon: Server }, { label: t('common.sshTunnel'), value: bookmark.name, icon: Network }, { label: currentTarget ? t('common.thisComputer') : t('app.hostReachableLocally'), value: targetEndpoint, icon: Monitor }]
      : [{ label: t('app.localSocks5'), value: bindEndpoint, icon: Monitor }, { label: t('common.sshTunnel'), value: `${bookmark.host}:${bookmark.port}`, icon: Server }, { label: t('app.requestedTarget'), value: targetEndpoint, icon: Network }]
  const selectTarget = (useCurrent: boolean): void => set('targetHost', useCurrent ? '127.0.0.1' : currentTarget ? '' : profile.targetHost)
  const save = async (): Promise<PortForwardProfile | undefined> => {
    try {
      const saved = await window.api.tunnels.saveProfile(profile)
      setProfile(saved); setProfiles((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      return saved
    } catch (error) { onError(errorMessage(error)); return undefined }
  }
  const start = async (): Promise<void> => {
    const saved = await save(); if (!saved) return
    setLoading(true)
    try {
      const tunnel = await window.api.tunnels.start(sessionId, saved.id)
      setTunnels((current) => [tunnel, ...current.filter((item) => item.id !== tunnel.id)])
    } catch (error) { onError(errorMessage(error)); setTunnels(await window.api.tunnels.list(sessionId)) }
    finally { setLoading(false) }
  }
  const stop = async (): Promise<void> => {
    if (!active) return
    setLoading(true)
    try { await window.api.tunnels.stop(sessionId, active.id); setTunnels((current) => current.filter((item) => item.id !== active.id)) }
    catch (error) { onError(errorMessage(error)) }
    finally { setLoading(false) }
  }
  return <Modal title={t('app.portForwardingValue', { value0: bookmark.name })} onClose={onClose} wide><div className="tunnel-dialog">
    <div className="deployment-profile-bar"><select value={profile.id} onChange={(event) => { const selected = profiles.find((item) => item.id === event.target.value); if (selected) setProfile(selected) }}><option value={profile.id}>{profiles.some((item) => item.id === profile.id) ? profile.name || t('common.unnamedProfile') : t('app.newForwardingProfile')}</option>{profiles.filter((item) => item.id !== profile.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="secondary-button" onClick={() => setProfile(empty())}><CirclePlus size={15} />{t('common.new')}</button>{profiles.some((item) => item.id === profile.id) && <button className="icon-button danger" title={t('app.deleteForwardingProfile')} onClick={async () => { if (active) await stop(); await window.api.tunnels.removeProfile(profile.id); const next = profiles.filter((item) => item.id !== profile.id); setProfiles(next); setProfile(next[0] ?? empty()) }}><Trash2 size={15} /></button>}</div>
    <div className="form-grid">
      <label>{t('app.profileNameOptional')}<input value={profile.name} onChange={(event) => set('name', event.target.value)} placeholder={t('app.leaveBlankToGenerateFromTheRoute')} /></label>
      <label>{t('app.forwardingType')}<select value={profile.type} disabled={Boolean(active)} onChange={(event) => set('type', event.target.value as PortForwardProfile['type'])}><option value="local">{t('app.localForwarding')}</option><option value="remote">{t('app.remoteForwarding')}</option><option value="dynamic">{t('app.dynamicSocks5')}</option></select></label>
      <section className="tunnel-route-preview"><span>{t('app.trafficRoute')}</span><div className="tunnel-route-flow">{route.map((step, index) => { const Icon = step.icon; return <div className="tunnel-route-part" key={step.label}>{index > 0 && <ArrowRight size={15} />}<div><Icon size={16} /><span><small>{step.label}</small><strong title={step.value}>{step.value}</strong></span></div></div> })}</div></section>
      <div className="form-row"><label>{profile.type === 'remote' ? t('app.sshServerBindAddress') : t('app.localBindAddress')}<input value={profile.bindAddress} disabled={Boolean(active)} onChange={(event) => set('bindAddress', event.target.value)} /></label><label>{t('app.bindPort')}<input type="number" min="0" max="65535" disabled={Boolean(active)} value={profile.bindPort} onChange={(event) => set('bindPort', Number(event.target.value))} /></label></div>
      {profile.bindPort === 0 && <div className="tunnel-hint">{t('app.port0IsAssignedAutomaticallyWhenStartingThe')}</div>}
      {window.api.platform === 'darwin' && profile.type !== 'remote' && profile.bindPort > 0 && profile.bindPort < 1024 && <div className="tunnel-hint warning">{t('app.regularMacosAppsCannotListenOnPrivilegedPorts')}</div>}
      {profile.type === 'local' && profile.bindPort === 6000 && <div className="tunnel-hint warning">{t('app.chromeBlocksLocalPort6000UseBindPort')}</div>}
      {profile.type !== 'dynamic' && <div className="tunnel-target-setting"><span>{t('app.targetLocation')}</span><div className="tunnel-target-options"><button type="button" className={currentTarget ? 'active' : ''} disabled={Boolean(active)} onClick={() => selectTarget(true)}>{profile.type === 'local' ? t('common.sshServer') : t('common.thisComputer')}</button><button type="button" className={!currentTarget ? 'active' : ''} disabled={Boolean(active)} onClick={() => selectTarget(false)}>{t('app.anotherHost')}</button></div></div>}
      {profile.type !== 'dynamic' && <div className="form-row"><label>{currentTarget ? profile.type === 'local' ? t('app.targetAddressSshServerItself') : t('app.targetAddressThisComputer') : profile.type === 'local' ? t('app.targetAddressFromSshServer') : t('app.targetAddressFromThisComputer')}<input value={profile.targetHost} readOnly={currentTarget} disabled={Boolean(active)} placeholder={currentTarget ? undefined : t('app.hostnameOrPrivateIp')} onChange={(event) => set('targetHost', event.target.value)} /></label><label>{t('app.targetPort')}<input type="number" min="1" max="65535" disabled={Boolean(active)} value={profile.targetPort} onChange={(event) => set('targetPort', Number(event.target.value))} /></label></div>}
      {active && <div className={`tunnel-status ${active.status}`}><span className={`status-dot ${active.status === 'running' ? 'connected' : active.status === 'error' ? 'error' : 'connecting'}`} /><strong>{active.status === 'running' ? t('app.runningValueValue', { value0: active.bindAddress, value1: active.bindPort }) : active.status === 'starting' ? t('app.starting') : t('app.forwardingError')}</strong>{active.error && <small>{active.error}</small>}</div>}
    </div>
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>{t('common.close')}</button><button className="secondary-button" disabled={Boolean(active) || loading} onClick={() => void save()}>{t('common.save')}</button>{active ? <button className="danger-button" disabled={loading} onClick={() => void stop()}>{t('app.stop')}</button> : <button className="primary-button" disabled={loading} onClick={() => void start()}><Power size={15} />{t('app.start')}</button>}</div>
  </div></Modal>
}

interface DeploymentPreviewNode {
  name: string
  path: string
  file?: DeploymentPreview['files'][number]
  children: Map<string, DeploymentPreviewNode>
}

function DeploymentPreviewBranch({ node }: { node: DeploymentPreviewNode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const children = [...node.children.values()].sort((a, b) => Number(b.children.size > 0) - Number(a.children.size > 0) || a.name.localeCompare(b.name))
  if (children.length === 0) return <li><div className="deployment-preview-tree-row" title={node.path}><span className="deployment-preview-chevron-spacer" /><File size={15} /><span>{node.name}</span><small title={`${(node.file?.size ?? 0).toLocaleString()} B`}>{formatFileSize(node.file?.size ?? 0)}</small></div></li>
  return <li><button type="button" className="deployment-preview-tree-row deployment-preview-folder" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<Folder size={15} /><span>{node.name}</span></button>{expanded && <ul>{children.map((child) => <DeploymentPreviewBranch key={child.path} node={child} />)}</ul>}</li>
}

function DeploymentPreviewTree({ files, root, archive }: { files: DeploymentPreview['files']; root: string; archive: boolean }): React.JSX.Element {
  const nodes = useMemo(() => {
    const roots = new Map<string, DeploymentPreviewNode>()
    for (const file of files) {
      let siblings = roots
      let path = ''
      for (const part of file.relativePath.split('/')) {
        path = path ? `${path}/${part}` : part
        let node = siblings.get(part)
        if (!node) {
          node = { name: part, path, children: new Map() }
          siblings.set(part, node)
        }
        if (path === file.relativePath) node.file = file
        siblings = node.children
      }
    }
    return [...roots.values()].sort((a, b) => Number(b.children.size > 0) - Number(a.children.size > 0) || a.name.localeCompare(b.name))
  }, [files])
  return <div className="deployment-preview-tree"><div className="deployment-preview-tree-root">{archive ? <File size={16} /> : <FolderOpen size={16} />}<strong title={root}>{root}</strong>{archive && <small>{root.endsWith('.tar.gz') ? 'tar.gz' : 'ZIP'}</small>}</div><ul>{nodes.map((node) => <DeploymentPreviewBranch key={node.path} node={node} />)}</ul></div>
}

function DeploymentAiComposer({ archiveEnabled, archiveFormat, hasCommand, settings, onUse, onSettings, onClose }: { archiveEnabled: boolean; archiveFormat: DeploymentProfile['archiveFormat']; hasCommand: boolean; settings: AiSettings; onUse(command: string): void; onSettings(): void; onClose(): void }): React.JSX.Element {
  const { t } = useI18n()
  const [requirement, setRequirement] = useState('')
  const [suggestion, setSuggestion] = useState<AiCommandSuggestion | null>(null)
  const [draftCommand, setDraftCommand] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const variableContext = deploymentVariables.map((variable) => variable.name + ': ' + t(variable.descriptionKey)).join('\n')
  const generate = async (): Promise<void> => {
    if (!requirement.trim()) return
    const context = [
      'Generate a readable Bash script for a deployment Shell template. Put separate steps on separate lines and indent control blocks. It runs remotely after the upload, inside bash -lc. Do not include another bash -lc wrapper.',
      'The SSH execution channel allocates a PTY but does not provide interactive password input. If sudo is needed, use sudo -n so a password requirement fails immediately. For a privileged Bash-specific command or redirection, put the whole privileged operation inside sudo -n bash -lc, and do not assume sudo preserves deployment environment variables.',
      'The following deployment variables are available as environment variables. Their descriptions are part of the deployment UI and apply to this command:',
      variableContext,
      'UPLOAD_DIR is only the remote upload directory. The final deployment directory may be elsewhere after the script extracts or copies the uploaded files. Do not treat UPLOAD_DIR as the final deployment directory unless the user explicitly says so.',
      'Reference variables as unquoted template placeholders, for example {{UPLOAD_DIR}} and {{FILE_PATH}}. The app converts each placeholder to a safely quoted Shell expansion at execution time. Do not wrap placeholders in additional quotes.',
      archiveEnabled ? `Upload mode: one ${archiveFormat === 'tarGz' ? 'tar.gz' : 'ZIP'} file. FILE_NAME and FILE_PATH refer to that archive. Its name is the workspace root directory followed by _yyyyMMddHHmmss and the format extension.` : 'Upload mode: individual files. When multiple files are selected, FILE_NAME and FILE_PATH are empty.',
      'Do not assume any concrete remote path. Generate the command only; do not execute it.',
      'User request: ' + requirement.trim(),
    ].join('\n')
    setLoading(true); setError(''); setSuggestion(null); setDraftCommand('')
    try { const next = await window.api.ai.generate(context, 'linux', undefined, false, true); setSuggestion(next); setDraftCommand(next.command) }
    catch (generateError) { setError(errorMessage(generateError)) }
    finally { setLoading(false) }
  }
  const riskText = suggestion ? ({ low: t('common.lowRisk'), medium: t('common.caution'), high: t('common.highRisk') } as const)[suggestion.riskLevel] : ''
  return <Modal title={t('deployment.aiAssist')} onClose={onClose} wide raised className="deployment-ai-modal"><div className="deployment-ai-dialog">
    <div className="deployment-ai-content">
      {!settings.model.trim() ? <div className="deployment-ai-unconfigured"><span>{t('app.noAiModelConfigured')}</span><button type="button" className="secondary-button" onClick={onSettings}><SettingsIcon size={15} />{t('app.openAiSettings')}</button></div> : <>
        <label className="deployment-ai-prompt">{t('deployment.aiPrompt')}<textarea autoFocus rows={3} maxLength={1800} value={requirement} placeholder={t('deployment.aiPlaceholder')} onChange={(event) => setRequirement(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void generate() } }} /></label>
        <div className="deployment-ai-actions"><span>{t('deployment.aiHint')}</span><button type="button" className="primary-button" disabled={loading || !requirement.trim()} onClick={() => void generate()}><WandSparkles size={15} />{loading ? t('app.generating') : t('app.generateCommand')}</button></div>
        {error && <div className="ai-error" role="alert">{error}</div>}
        {suggestion && <div className="deployment-ai-result"><div className="ai-result-heading"><div><strong>{t('app.generatedResult')}</strong><span className={'ai-risk ' + suggestion.riskLevel}>{riskText}</span></div></div><label>{t('deployment.aiEditResult')}<textarea rows={9} value={draftCommand} onChange={(event) => setDraftCommand(event.target.value)} spellCheck={false} /></label>{suggestion.explanation && <p>{suggestion.explanation}</p>}{suggestion.assumptions.length > 0 && <details className="ai-notes"><summary>{t('app.assumptions')} <span>{suggestion.assumptions.length}</span></summary><ul>{suggestion.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></details>}{suggestion.warnings.length > 0 && <details className="ai-notes warning"><summary>{t('app.warnings')} <span>{suggestion.warnings.length}</span></summary><ul>{suggestion.warnings.map((item) => <li key={item}>{item}</li>)}</ul></details>}</div>}
        <details className="deployment-preview-details deployment-ai-context"><summary>{t('deployment.aiContext')}</summary><pre className="deployment-code">{variableContext}</pre></details>
      </>}
    </div>
    <div className="deployment-ai-footer"><button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="primary-button" disabled={!suggestion || !draftCommand.trim()} onClick={() => onUse(draftCommand)}>{hasCommand ? t('deployment.aiReplace') : t('deployment.aiUse')}</button></div>
  </div></Modal>
}

function DeploymentImportDialog({ bundle, target, onClose, onImported, onError }: { bundle: DeploymentBundle; target: Bookmark; onClose(): void; onImported(items: DeploymentProfile[]): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const [tasks, setTasks] = useState(bundle.tasks.map((task) => ({ ...task })))
  const [selected, setSelected] = useState(new Set(bundle.tasks.map((_, index) => index)))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const chooseWorkspace = async (index: number): Promise<void> => {
    try { const path = await window.api.files.chooseLocalDirectory(); if (path) setTasks((current) => current.map((task, position) => position === index ? { ...task, workspace: path } : task)) }
    catch (chooseError) { onError(errorMessage(chooseError)) }
  }
  const importTasks = async (): Promise<void> => {
    setLoading(true); setError('')
    try { onImported(await window.api.deployments.importBundle(target.id, tasks.filter((_, index) => selected.has(index)))) }
    catch (importError) { setError(errorMessage(importError)) }
    finally { setLoading(false) }
  }
  const canImport = selected.size > 0 && tasks.every((task, index) => !selected.has(index) || Boolean(task.workspace.trim()))
  return <Modal title={t('deployment.importTasks')} onClose={onClose} wide raised className="deployment-import-modal"><div className="deployment-import-dialog">
    <p className="deployment-import-hint">{t('deployment.importSource', { source: bundle.sourceConnection, target: target.name })}<br />{t('deployment.importHint')}</p>
    <div className="deployment-import-list">{tasks.map((task, index) => <div className="deployment-import-row" key={index}>
      <label className="check-label"><input type="checkbox" checked={selected.has(index)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next })} /><strong>{task.name}</strong>{task.schedule.enabled && <small>{t('deployment.schedule')} · {task.schedule.dailyTime}</small>}</label>
      <small title={task.workspace}>{t('deployment.originalWorkspace')}: {task.workspace}</small>
      <label>{t('deployment.targetWorkspace')}<div className="input-button"><input value={task.workspace} disabled={!selected.has(index)} onChange={(event) => setTasks((current) => current.map((item, position) => position === index ? { ...item, workspace: event.target.value } : item))} /><button type="button" className="secondary-button" disabled={!selected.has(index)} onClick={() => void chooseWorkspace(index)}>{t('common.choose')}</button></div></label>
    </div>)}</div>
    {error && <p className="deployment-result-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="primary-button" disabled={!canImport || loading} onClick={() => void importTasks()}>{loading ? t('app.importing') : t('deployment.importSelected', { count: selected.size })}</button></div>
  </div></Modal>
}

function DeploymentDialog({ bookmark, sessionId, aiSettings, onOpenAiSettings, onClose, onConfirm, onNotice, onError }: { bookmark: Bookmark; sessionId: string; aiSettings: AiSettings; onOpenAiSettings(): void; onClose(): void; onConfirm: ConfirmAction; onNotice(message: string): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const shellEditorRef = useRef<HTMLTextAreaElement>(null)
  const hookEditorRef = useRef<HTMLTextAreaElement>(null)
  const shellSelectionRef = useRef({ start: 0, end: 0 })
  const editorFocusPendingRef = useRef(false)
  const previewRef = useRef<HTMLElement>(null)
  const resultRef = useRef<HTMLElement>(null)
  const historyResultRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const workspaceButtonRef = useRef<HTMLButtonElement>(null)
  const rootSelectionRef = useRef<HTMLInputElement>(null)
  const remoteDirectoryRef = useRef<HTMLInputElement>(null)
  const scheduleTimeRef = useRef<HTMLInputElement>(null)
  const scheduleDetailsRef = useRef<HTMLDetailsElement>(null)
  const hookUrlRef = useRef<HTMLInputElement>(null)
  const hookDetailsRef = useRef<HTMLDetailsElement>(null)
  const previewRequestIdRef = useRef<string | null>(null)
  const withHookDefaults = (item: DeploymentProfile): DeploymentProfile => { let legacyTemplate: DeploymentProfile['hookTemplate'] = 'custom'; try { if (['open.feishu.cn', 'open.larksuite.com'].includes(new URL(item.hookUrl).hostname) && !item.hookBody?.trim()) legacyTemplate = 'feishu' } catch { /* Empty or older URL; keep the generic template. */ } return { ...item, hookUrl: item.hookUrl ?? '', hookTemplate: item.hookTemplate ?? legacyTemplate, hookBody: item.hookBody ?? '' } }
  const empty = (): DeploymentProfile => ({ id: crypto.randomUUID(), bookmarkId: bookmark.id, name: '', workspace: '', selection: { included: [], excluded: [] }, remoteDirectory: '/', archiveEnabled: true, archiveFormat: 'zip', shellTemplate: '', shell: 'bash', confirmManual: true, schedule: { enabled: false, dailyTime: '09:00' }, hookUrl: '', hookTemplate: 'custom', hookBody: '' })
  const [profiles, setProfiles] = useState<DeploymentProfile[]>([])
  const [profile, setProfile] = useState<DeploymentProfile>(empty)
  const savedProfileRef = useRef(profile)
  const profileTouchedRef = useRef(false)
  const [view, setView] = useState<'deploy' | 'preview' | 'run' | 'history'>('deploy')
  const [validationAction, setValidationAction] = useState<'save' | 'deploy' | null>(null)
  const [tree, setTree] = useState<Record<string, DirectoryEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [previewData, setPreviewData] = useState<DeploymentPreview | null>(null)
  const [previewProgress, setPreviewProgress] = useState<DeploymentPreviewProgress | null>(null)
  const [deploymentProgress, setDeploymentProgress] = useState<DeploymentProgress | null>(null)
  const deploymentRequestIdRef = useRef<string | null>(null)
  const [runs, setRuns] = useState<DeploymentRun[]>([])
  const [run, setRun] = useState<DeploymentRun | null>(null)
  const [viewRunId, setViewRunId] = useState<string | null>(null)
  const [historyRun, setHistoryRun] = useState<DeploymentRun | null>(null)
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set())
  const [aiComposerOpen, setAiComposerOpen] = useState(false)
  const [importBundle, setImportBundle] = useState<DeploymentBundle | null>(null)
  const [editorExpanded, setEditorExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!editorFocusPendingRef.current) return
    const frame = window.requestAnimationFrame(() => {
      editorFocusPendingRef.current = false
      const editor = shellEditorRef.current
      if (!editor) return
      editor.focus()
      editor.setSelectionRange(shellSelectionRef.current.start, shellSelectionRef.current.end)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editorExpanded])
  useEffect(() => { void window.api.deployments.list(bookmark.id).then((items) => { setProfiles(items); if (items[0] && !profileTouchedRef.current) { const selected = withHookDefaults(items[0]); savedProfileRef.current = selected; setProfile(selected) } }).catch((error) => onError(errorMessage(error))) }, [bookmark.id])
  useEffect(() => window.api.onEvent((event) => {
    if (event.type === 'deployment-preview-progress' && event.payload.requestId === previewRequestIdRef.current) setPreviewProgress(event.payload)
    if (event.type === 'deployment-progress' && event.payload.requestId === deploymentRequestIdRef.current) setDeploymentProgress(event.payload)
  }), [])
  useEffect(() => {
    setTree({}); setExpanded(new Set())
    if (profile.workspace) void window.api.deployments.tree(profile.workspace, '.').then((items) => setTree({ '.': items })).catch((error) => onError(errorMessage(error)))
  }, [profile.workspace])
  useEffect(() => {
    if (!profiles.some((item) => item.id === profile.id)) { setRuns([]); return }
    const load = (): void => { void window.api.deployments.runsList(profile.id).then(setRuns).catch((error) => onError(errorMessage(error))) }
    load(); const timer = window.setInterval(load, 1500)
    return () => window.clearInterval(timer)
  }, [profile.id, profiles.length])
  const set = <K extends keyof DeploymentProfile>(key: K, value: DeploymentProfile[K]): void => { profileTouchedRef.current = true; setProfile((current) => ({ ...current, [key]: value })); setPreviewData(null) }
  const toggleEditorExpanded = (): void => {
    const editor = shellEditorRef.current
    if (editor) shellSelectionRef.current = { start: editor.selectionStart, end: editor.selectionEnd }
    editorFocusPendingRef.current = true
    setEditorExpanded((current) => !current)
  }
  const closeAiComposer = (): void => {
    setAiComposerOpen(false)
    window.requestAnimationFrame(() => shellEditorRef.current?.focus())
  }
  const insertShellVariable = (name: string): void => {
    const editor = shellEditorRef.current
    const start = editor?.selectionStart ?? profile.shellTemplate.length
    const end = editor?.selectionEnd ?? start
    const before = profile.shellTemplate[start - 1]
    const after = profile.shellTemplate[end]
    const leadingSpace = before && !/\s/.test(before) && !'=([{;|&'.includes(before) ? ' ' : ''
    const trailingSpace = after && !/\s/.test(after) && !')]}:;,|&'.includes(after) ? ' ' : ''
    const insertion = leadingSpace + '{{' + name + '}}' + trailingSpace
    set('shellTemplate', profile.shellTemplate.slice(0, start) + insertion + profile.shellTemplate.slice(end))
    window.requestAnimationFrame(() => {
      shellEditorRef.current?.focus()
      shellEditorRef.current?.setSelectionRange(start + insertion.length, start + insertion.length)
    })
  }
  const insertHookVariable = (name: string): void => {
    const editor = hookEditorRef.current
    const start = editor?.selectionStart ?? profile.hookBody.length
    const end = editor?.selectionEnd ?? start
    const insertion = `{{${name}}}`
    set('hookBody', profile.hookBody.slice(0, start) + insertion + profile.hookBody.slice(end))
    window.requestAnimationFrame(() => {
      hookEditorRef.current?.focus()
      hookEditorRef.current?.setSelectionRange(start + insertion.length, start + insertion.length)
    })
  }
  type DeploymentField = 'name' | 'workspace' | 'selection' | 'remoteDirectory' | 'schedule' | 'hookUrl' | 'hookBody'
  const validationIssues = (action: 'save' | 'deploy'): { field: DeploymentField; message: string }[] => {
    const issues: { field: DeploymentField; message: string }[] = []
    if (!profile.name.trim()) issues.push({ field: 'name', message: t('deployment.validation.name') })
    if (!profile.workspace.trim() || !(/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(profile.workspace.trim()))) issues.push({ field: 'workspace', message: t('deployment.validation.workspace') })
    if ((action === 'deploy' || profile.schedule.enabled) && profile.selection.included.length === 0) issues.push({ field: 'selection', message: t(profile.schedule.enabled ? 'deployment.validation.scheduleSelection' : 'deployment.validation.selection') })
    const remote = profile.remoteDirectory.trim()
    if (!remote.startsWith('/') || /[\0\n]/.test(remote) || remote.split('/').some((part) => part === '.' || part === '..')) issues.push({ field: 'remoteDirectory', message: t('deployment.validation.remoteDirectory') })
    if (profile.schedule.enabled && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(profile.schedule.dailyTime)) issues.push({ field: 'schedule', message: t('deployment.validation.scheduleTime') })
    if (profile.hookUrl.trim()) {
      try {
        const url = new URL(profile.hookUrl.trim())
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid URL')
      } catch { issues.push({ field: 'hookUrl', message: t('deployment.validation.hookUrl') }) }
      if (profile.hookTemplate === 'custom' && profile.hookBody.trim()) {
        const allowedVariables = new Set(['summary', 'runId', 'deploymentId', 'deploymentName', 'taskName', 'bookmarkId', 'triggerType', 'status', 'succeeded', 'startedAt', 'finishedAt', 'durationSeconds', 'selectedFileCount', 'archiveSize', 'archiveSizeText', 'uploadDirectory', 'commandExitCode', 'error'])
        const unknown = [...profile.hookBody.matchAll(/{{([^{}]+)}}/g)].map((match) => (match[1] ?? '').trim().replace(/^json\./, '')).find((name) => !allowedVariables.has(name))
        if (unknown) issues.push({ field: 'hookBody', message: t('deployment.validation.hookVariable', { name: unknown }) })
        else {
          try { JSON.parse(profile.hookBody.replace(/{{[^{}]+}}/g, 'null')) }
          catch { issues.push({ field: 'hookBody', message: t('deployment.validation.hookBody') }) }
        }
      }
    }
    return issues
  }
  const focusIssue = (field: DeploymentField): void => {
    if (field === 'schedule' && scheduleDetailsRef.current) scheduleDetailsRef.current.open = true
    if ((field === 'hookUrl' || field === 'hookBody') && hookDetailsRef.current) hookDetailsRef.current.open = true
    window.requestAnimationFrame(() => {
      const target = ({ name: nameRef, workspace: workspaceButtonRef, selection: rootSelectionRef, remoteDirectory: remoteDirectoryRef, schedule: scheduleTimeRef, hookUrl: hookUrlRef, hookBody: hookEditorRef } as const)[field].current
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target?.focus()
    })
  }
  const validateAction = (action: 'save' | 'deploy'): boolean => {
    setValidationAction(action)
    const first = validationIssues(action)[0]
    if (first) { focusIssue(first.field); return false }
    return true
  }
  const hasUnsavedChanges = (): boolean => JSON.stringify(profile) !== JSON.stringify(savedProfileRef.current)
  const discardChanges = async (): Promise<boolean> => !hasUnsavedChanges() || await onConfirm({ title: t('deployment.unsavedTitle'), message: t('deployment.unsavedMessage'), kind: 'warning', confirmLabel: t('deployment.discardChanges') })
  const requestClose = async (): Promise<void> => { if (await discardChanges()) onClose() }
  const save = async (confirmLabel = t('deployment.save')): Promise<DeploymentProfile | undefined> => {
    const previous = profiles.find((item) => item.id === profile.id)
    if (profile.schedule.enabled && (!previous || JSON.stringify(previous) !== JSON.stringify(profile))) {
      const accepted = await onConfirm({ title: t('deployment.schedule'), message: t('deployment.scheduleRisk'), kind: 'warning', confirmLabel })
      if (!accepted) return undefined
    }
    try {
      const saved = await window.api.deployments.save(profile)
      savedProfileRef.current = saved
      setProfile(saved); setProfiles((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      setValidationAction(null)
      if (JSON.stringify(saved) !== JSON.stringify(profile)) setPreviewData(null)
      return saved
    } catch (error) { onError(errorMessage(error)); return undefined }
  }
  const saveTask = async (): Promise<void> => {
    if (!validateAction('save')) return
    setBusy(true)
    try { if (await save()) onNotice(t('deployment.savedTask')) }
    finally { setBusy(false) }
  }
  const loadTree = async (relative: string): Promise<void> => {
    if (tree[relative]) return
    try { const items = await window.api.deployments.tree(profile.workspace, relative); setTree((current) => ({ ...current, [relative]: items })) }
    catch (error) { onError(errorMessage(error)) }
  }
  const toggleFolder = (relative: string): void => {
    setExpanded((current) => { const next = new Set(current); if (next.has(relative)) next.delete(relative); else next.add(relative); return next })
    void loadTree(relative)
  }
  const covered = (relative: string, rules: string[]): boolean => rules.some((rule) => rule === '.' || relative === rule || relative.startsWith(`${rule}/`))
  const selectionState = (relative: string, kind: DirectoryEntry['kind']): { checked: boolean; mixed: boolean } => {
    const excluded = covered(relative, profile.selection.excluded)
    const checked = !excluded && covered(relative, profile.selection.included)
    const mixed = kind === 'directory' && (checked && profile.selection.excluded.some((rule) => rule.startsWith(`${relative}/`)) || !checked && profile.selection.included.some((rule) => rule.startsWith(`${relative}/`)))
    return { checked, mixed }
  }
  const select = (relative: string, checked: boolean): void => {
    profileTouchedRef.current = true
    setProfile((current) => {
      let included = current.selection.included.filter((rule) => relative === '.' ? false : rule !== relative && !rule.startsWith(`${relative}/`))
      let excluded = current.selection.excluded.filter((rule) => relative === '.' ? false : rule !== relative && !rule.startsWith(`${relative}/`))
      if (checked) { excluded = excluded.filter((rule) => rule !== '.' && !(relative === rule || relative.startsWith(`${rule}/`))); included = [...included, relative] }
      else if (covered(relative, current.selection.included)) excluded = [...excluded, relative]
      return { ...current, selection: { included, excluded } }
    })
    setPreviewData(null)
  }
  const renderNodes = (parent: string): React.ReactNode => (tree[parent] ?? []).map((item) => {
    const relative = parent === '.' ? item.name : `${parent}/${item.name}`
    const folder = item.kind === 'directory'
    const state = selectionState(relative, item.kind)
    return <li className="deployment-tree-node" key={relative}><div className="deployment-tree-row">
      {folder ? <button type="button" className="icon-button" title={expanded.has(relative) ? t('deployment.collapse') : t('deployment.expand')} aria-expanded={expanded.has(relative)} onClick={() => toggleFolder(relative)}>{expanded.has(relative) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="deployment-tree-spacer" />}
      <input type="checkbox" aria-label={relative} disabled={item.kind === 'symlink' || item.kind === 'other'} checked={state.checked} ref={(element) => { if (element) element.indeterminate = state.mixed }} onChange={(event) => select(relative, event.target.checked)} />
      {folder ? <>{expanded.has(relative) ? <FolderOpen size={15} className="deployment-file-icon deployment-folder-icon" /> : <Folder size={15} className="deployment-file-icon deployment-folder-icon" />}<button type="button" className="deployment-tree-name" onClick={() => toggleFolder(relative)}>{item.name}</button></> : <><File size={15} className="deployment-file-icon" /><span className={item.kind === 'symlink' ? 'muted' : ''}>{item.name}{item.kind === 'symlink' ? ' ↗' : ''}</span></>}
    </div>{folder && expanded.has(relative) && <ul className="deployment-tree-children">{renderNodes(relative)}</ul>}</li>
  })
  const refreshRuns = async (): Promise<void> => { setRuns(await window.api.deployments.runsList(profile.id)) }
  const preview = async (): Promise<void> => {
    if (!validateAction('deploy')) return
    const requestId = crypto.randomUUID()
    previewRequestIdRef.current = requestId
    setPreviewProgress({ requestId, phase: 'scanning', filesTotal: 0, filesProcessed: 0, bytesTotal: 0, bytesProcessed: 0 })
    setBusy(true)
    try {
      setView('deploy')
      setPreviewData(null)
      const next = await window.api.deployments.preview(profile, requestId)
      if (previewRequestIdRef.current !== requestId) return
      setPreviewData(next); setRun(null); setView('preview')
    }
    catch (error) { onError(errorMessage(error)) }
    finally { if (previewRequestIdRef.current === requestId) { previewRequestIdRef.current = null; setPreviewProgress(null); setBusy(false) } }
  }
  const execute = async (): Promise<void> => {
    if (!validateAction('deploy')) return
    setBusy(true)
    try {
      const saved = await save(t('deployment.run')); if (!saved) return
      const archiveFileName = JSON.stringify(saved) === JSON.stringify(profile) ? previewData?.archiveFileName ?? undefined : undefined
      const requestId = crypto.randomUUID()
      deploymentRequestIdRef.current = requestId
      setDeploymentProgress({ requestId, phase: 'preparing', bytesTotal: 0, bytesProcessed: 0 })
      setRun(null)
      setViewRunId(null)
      setView('run')
      const next = await window.api.deployments.execute(saved.id, sessionId, archiveFileName, requestId)
      setRun(next)
      await refreshRuns()
      if (next.status === 'failed') onError(t('deployment.failed', { error: next.error ?? '' }))
    } catch (error) { onError(errorMessage(error)) }
    finally { deploymentRequestIdRef.current = null; setDeploymentProgress(null); setBusy(false) }
  }
  const confirm = async (id: string): Promise<void> => {
    setDeploymentProgress({ requestId: id, phase: 'executing-command', bytesTotal: 0, bytesProcessed: 0 })
    setBusy(true)
    try {
      const next = await window.api.deployments.confirm(id)
      if (view === 'history') { setHistoryRun(next); if (run?.id === id) setRun(next) }
      else { setRun(next); if (historyRun?.id === id) setHistoryRun(next) }
      if (view === 'history') window.requestAnimationFrame(() => historyResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      await refreshRuns()
      if (next.status === 'failed') onError(t('deployment.failed', { error: next.error ?? '' }))
    }
    catch (error) { onError(errorMessage(error)) }
    finally { setDeploymentProgress(null); setBusy(false) }
  }
  const cancel = async (id: string): Promise<void> => {
    try {
      await window.api.deployments.cancel(id); await refreshRuns()
      if (run?.id === id || historyRun?.id === id) {
        const next = await window.api.deployments.runGet(id)
        if (run?.id === id) setRun(next)
        if (historyRun?.id === id) setHistoryRun(next)
      }
    }
    catch (error) { onError(errorMessage(error)) }
  }
  const statusText: Record<string, string> = { draft: t('deployment.status.draft'), preparing: t('deployment.status.preparing'), packaging: t('deployment.status.packaging'), uploading: t('deployment.status.uploading'), 'awaiting-confirmation': t('deployment.status.awaiting'), 'executing-command': t('deployment.status.executing'), succeeded: t('deployment.status.succeeded'), failed: t('deployment.status.failed'), cancelled: t('deployment.status.cancelled') }
  const activeRun = runs.find((item) => !['succeeded', 'failed', 'cancelled'].includes(item.status))
  const shownRun = viewRunId ? (run?.id === viewRunId ? run : runs.find((item) => item.id === viewRunId) ?? null) : run && !['succeeded', 'failed', 'cancelled'].includes(run.status) ? run : activeRun ?? run
  const viewedRunStatus = viewRunId ? runs.find((item) => item.id === viewRunId)?.status : undefined
  useEffect(() => {
    if (view !== 'run' || !viewRunId || run?.id === viewRunId || !viewedRunStatus || !['succeeded', 'failed', 'cancelled'].includes(viewedRunStatus)) return
    let active = true
    void window.api.deployments.runGet(viewRunId).then((details) => { if (active && details) setRun(details) }).catch((error) => { if (active) onError(errorMessage(error)) })
    return () => { active = false }
  }, [view, viewRunId, viewedRunStatus, run?.id])
  const switchProfile = (next: DeploymentProfile): void => { previewRequestIdRef.current = null; deploymentRequestIdRef.current = null; setPreviewProgress(null); setDeploymentProgress(null); setBusy(false); const selected = withHookDefaults(next); savedProfileRef.current = selected; profileTouchedRef.current = true; setProfile(selected); setPreviewData(null); setRun(null); setViewRunId(null); setHistoryRun(null); setRuns([]); setSelectedRuns(new Set()); setAiComposerOpen(false); setEditorExpanded(false); setValidationAction(null); setView('deploy') }
  const requestSwitchProfile = async (next: DeploymentProfile): Promise<void> => { if (next.id !== profile.id && await discardChanges()) switchProfile(next) }
  const chooseWorkspace = async (): Promise<void> => {
    try {
      const path = await window.api.files.chooseLocalDirectory()
      if (!path || (window.api.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() === profile.workspace.replaceAll('\\', '/').toLowerCase() : path === profile.workspace)) return
      if (profile.selection.included.length > 0 && !await onConfirm({ title: t('deployment.changeWorkspaceTitle'), message: t('deployment.changeWorkspaceMessage'), kind: 'warning', confirmLabel: t('deployment.changeWorkspace') })) return
      profileTouchedRef.current = true
      setProfile((current) => ({ ...current, workspace: path, selection: { included: [], excluded: [] } })); setPreviewData(null)
    } catch (error) { onError(errorMessage(error)) }
  }
  const exportTasks = async (): Promise<void> => {
    try { const path = await window.api.deployments.exportBundle(bookmark.id); if (path) onNotice(t('deployment.exportedTasks', { path })) }
    catch (error) { onError(errorMessage(error)) }
  }
  const pickImportTasks = async (): Promise<void> => {
    if (!await discardChanges()) return
    try { const bundle = await window.api.deployments.pickBundle(); if (bundle) setImportBundle(bundle) }
    catch (error) { onError(errorMessage(error)) }
  }
  const visibleIssues = validationAction ? validationIssues(validationAction) : []
  const fieldIssue = (field: DeploymentField): string | undefined => visibleIssues.find((issue) => issue.field === field)?.message
  const progressMaximum = previewProgress?.phase === 'hashing' ? previewProgress.bytesTotal || previewProgress.filesTotal : 0
  const progressValue = previewProgress?.phase === 'hashing' ? previewProgress.bytesTotal ? Math.min(previewProgress.bytesProcessed, previewProgress.bytesTotal) : previewProgress.filesProcessed : 0
  const progressPercent = progressMaximum ? Math.round(progressValue / progressMaximum * 100) : 0
  const deploymentPercent = (() => {
    if (!deploymentProgress) return 0
    const fraction = deploymentProgress.bytesTotal ? Math.min(1, deploymentProgress.bytesProcessed / deploymentProgress.bytesTotal) : 0
    const archive = profile.archiveEnabled
    switch (deploymentProgress.phase) {
      case 'preparing': return 0
      case 'snapshot': return Math.round((archive ? 25 : 35) * fraction)
      case 'packaging': return Math.round(25 + 35 * fraction)
      case 'connecting': return archive ? 60 : 35
      case 'uploading': return Math.round((archive ? 60 : 35) + (archive ? 35 : 60) * fraction)
      case 'executing-command': return 95
    }
  })()
  const archiveDestination = previewData?.archiveFileName ? `${previewData.remoteTargetDirectory.replace(/\/$/, '')}/${previewData.archiveFileName}` : ''
  const renderRunResult = (shownRun: DeploymentRun, elementRef: React.RefObject<HTMLElement | null>): React.JSX.Element => <section className="deployment-section deployment-result" ref={elementRef}>
        <div className="deployment-result-heading"><strong aria-live="polite">{statusText[shownRun.status] ?? shownRun.status}</strong><time>{new Date(shownRun.startedAt).toLocaleString()}</time>{shownRun.commandExitCode !== undefined && shownRun.commandExitCode !== null && <span>{t('deployment.exitCode')}: {shownRun.commandExitCode}</span>}</div>
        <code>{shownRun.remoteDestinationDir}</code>
        {shownRun.error && <p className="deployment-result-error">{shownRun.error}</p>}
        {shownRun.hookError && <p className="deployment-result-error">{t('deployment.hookFailed')}: {shownRun.hookError}</p>}
        {shownRun.status === 'awaiting-confirmation' && <>{shownRun.commandLine && <pre className="deployment-code">{shownRun.commandLine}</pre>}<div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => void cancel(shownRun.id)}>{t('deployment.cancelCommand')}</button><button className="primary-button" disabled={busy} onClick={() => void confirm(shownRun.id)}>{t('deployment.confirmRun')}</button></div></>}
        {(shownRun.commandExitCode !== undefined && shownRun.commandExitCode !== null || Boolean(shownRun.stdout) || Boolean(shownRun.stderr)) && <div className="deployment-shell-result">
          <strong>{t('deployment.shellResult')}</strong>
          <div className="deployment-copy-heading"><span>{t('deployment.output')}</span>{shownRun.stdout && <button className="text-button" onClick={() => void window.api.system.writeClipboard(shownRun.stdout)}>{t('deployment.copy')}</button>}</div>
          <pre className="deployment-code">{shownRun.stdout || t('deployment.noOutput')}</pre>
          {shownRun.stderr && <><div className="deployment-copy-heading"><span>{t('deployment.errorOutput')}</span><button className="text-button" onClick={() => void window.api.system.writeClipboard(shownRun.stderr)}>{t('deployment.copy')}</button></div><pre className="deployment-code">{shownRun.stderr}</pre></>}
        </div>}
        {shownRun.commandLine && shownRun.status !== 'awaiting-confirmation' && <details className="deployment-preview-details"><summary>{t('deployment.expandedCommand')}</summary><pre className="deployment-code">{shownRun.commandLine}</pre></details>}
      </section>
  return <Modal title={t('deployment.title') + ' · ' + bookmark.name} onClose={() => void requestClose()} wide className="deployment-modal" suppressContextMenu><div className="deployment-dialog">
    <div className="deployment-profile-bar">
      <label><span>{t('deployment.task')}{hasUnsavedChanges() && <em className="deployment-dirty-mark">{t('deployment.unsavedMark')}</em>}</span><select value={profile.id} disabled={busy} onChange={(event) => { const next = profiles.find((item) => item.id === event.target.value); if (next) void requestSwitchProfile(next) }}><option value={profile.id}>{profiles.some((item) => item.id === profile.id) ? profile.name || t('common.unnamedProfile') : t('deployment.new')}</option>{profiles.filter((item) => item.id !== profile.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {profiles.some((item) => item.id === profile.id) && <button className="secondary-button" disabled={busy} onClick={() => void requestSwitchProfile(empty())}><CirclePlus size={15} />{t('common.new')}</button>}
      {profiles.some((item) => item.id === profile.id) && <button className="icon-button danger" disabled={busy} title={t('deployment.delete')} onClick={async () => { if (!await onConfirm({ title: t('deployment.delete'), message: t('deployment.deleteConfirm'), kind: 'danger', confirmLabel: t('deployment.delete') })) return; try { await window.api.deployments.remove(profile.id); const next = profiles.filter((item) => item.id !== profile.id); setProfiles(next); switchProfile(next[0] ?? empty()) } catch (error) { onError(errorMessage(error)) } }}><Trash2 size={15} /></button>}
      <div className="deployment-profile-transfer-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void pickImportTasks()}><Upload size={15} />{t('deployment.importTasks')}</button><button type="button" className="secondary-button" disabled={busy || profiles.length === 0} onClick={() => void exportTasks()}><Download size={15} />{t('deployment.exportTasks')}</button></div>
    </div>
    <nav className="deployment-tabs" aria-label={t('deployment.title')}><button type="button" className={view !== 'history' ? 'active' : ''} aria-current={view !== 'history' ? 'page' : undefined} onClick={() => { setViewRunId(null); setView('deploy') }}>{t('deployment.title')}</button><button type="button" className={view === 'history' ? 'active' : ''} aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')}>{t('deployment.history')}{runs.length > 0 && <span>{runs.length}</span>}</button></nav>
    <div className="deployment-flow" hidden={view !== 'deploy'}>
      {shownRun && !['succeeded', 'failed', 'cancelled'].includes(shownRun.status) && <button type="button" className="deployment-active-banner" onClick={() => { setViewRunId(shownRun.id); setView('run') }}><span>{t('deployment.activeRun')}: {statusText[shownRun.status] ?? shownRun.status}</span><ChevronRight size={15} /></button>}
      <section className="deployment-section deployment-files">
        <div className="deployment-source-fields">
          <label>{t('deployment.name')}<input ref={nameRef} value={profile.name} aria-invalid={Boolean(fieldIssue('name'))} placeholder={t('deployment.namePlaceholder')} onChange={(event) => set('name', event.target.value)} />{fieldIssue('name') && <small className="deployment-field-error">{fieldIssue('name')}</small>}</label>
          <label>{t('deployment.workspace')}<div className="input-button"><input readOnly value={profile.workspace} placeholder={t('deployment.noWorkspace')} title={profile.workspace} /><button ref={workspaceButtonRef} className="secondary-button" onClick={() => void chooseWorkspace()}>{profile.workspace ? t('deployment.changeWorkspace') : t('common.choose')}</button></div>{fieldIssue('workspace') && <small className="deployment-field-error">{fieldIssue('workspace')}</small>}</label>
        </div>
        <section className="deployment-file-panel">
          <header><strong>{t('deployment.filesHeading')}</strong>{profile.workspace && <small>{t('deployment.selectionHint')}</small>}</header>
          {profile.workspace ? <><div className="deployment-tree"><ul className="deployment-tree-list"><li className="deployment-tree-node deployment-tree-root"><div className="deployment-tree-row deployment-root-row"><span className="deployment-tree-spacer" /><input type="checkbox" aria-label={t('deployment.selectAllFiles')} checked={profile.selection.included.includes('.') && profile.selection.excluded.length === 0} ref={(element) => { rootSelectionRef.current = element; if (element) element.indeterminate = profile.selection.included.includes('.') ? profile.selection.excluded.length > 0 : profile.selection.included.length > 0 }} onChange={(event) => select('.', event.target.checked)} /><FolderOpen size={15} className="deployment-file-icon deployment-folder-icon" /><strong title={profile.workspace}>{profile.workspace.split(/[\\/]/).filter(Boolean).pop() || profile.workspace}</strong></div><ul className="deployment-tree-children">{renderNodes('.')}</ul></li></ul></div>{previewData && <footer>{t('deployment.selected', { count: previewData.files.length, size: formatFileSize(previewData.totalSize) })}</footer>}</> : <div className="deployment-empty"><strong>{t('deployment.emptyWorkspaceTitle')}</strong><p>{t('deployment.emptyWorkspaceHint')}</p></div>}
        </section>
        {fieldIssue('selection') && <small className="deployment-field-error">{fieldIssue('selection')}</small>}
      </section>
      <section className="deployment-section deployment-settings">
        <div className="deployment-setting-card deployment-target-card">
          <label>{t('deployment.remoteTarget')}<input ref={remoteDirectoryRef} value={profile.remoteDirectory} aria-invalid={Boolean(fieldIssue('remoteDirectory'))} onChange={(event) => set('remoteDirectory', event.target.value)} />{fieldIssue('remoteDirectory') && <small className="deployment-field-error">{fieldIssue('remoteDirectory')}</small>}</label>
          <div className="deployment-archive-controls"><label className="check-label"><input type="checkbox" checked={profile.archiveEnabled} onChange={(event) => set('archiveEnabled', event.target.checked)} />{t('deployment.archive')}</label>{profile.archiveEnabled && <label>{t('deployment.archiveFormat')}<select value={profile.archiveFormat ?? 'zip'} onChange={(event) => set('archiveFormat', event.target.value as DeploymentProfile['archiveFormat'])}><option value="zip">ZIP</option><option value="tarGz">tar.gz</option></select></label>}</div>
          <p className="deployment-upload-hint">{t('deployment.uploadHint')}</p>
        </div>
        <details className="deployment-setting-card deployment-optional" key={profile.id + '-shell'}>
          <summary><span>{t('deployment.shell')}</span>{profile.shellTemplate.trim() && <small>{profile.confirmManual ? t('deployment.shellSummaryConfirm') : t('deployment.shellSummaryAuto')}</small>}</summary>
          <div className="deployment-optional-body">
            <div className="deployment-shell-toolbar"><label htmlFor="deployment-shell-editor">{t('deployment.shellCommand')}</label><button type="button" className="secondary-button" onClick={() => setAiComposerOpen(true)}><WandSparkles size={15} />{t('deployment.aiAssist')}</button></div>
            <div className="deployment-shell-editor-wrap"><textarea id="deployment-shell-editor" ref={editorExpanded ? undefined : shellEditorRef} rows={5} className="deployment-shell" value={profile.shellTemplate} onChange={(event) => set('shellTemplate', event.target.value)} spellCheck={false} /><button type="button" className="icon-button deployment-editor-corner-button" title={t('deployment.expandEditor')} aria-label={t('deployment.expandEditor')} aria-expanded={editorExpanded} onClick={toggleEditorExpanded}><Maximize2 size={16} /></button></div>
            {/\bsudo\b/.test(profile.shellTemplate) && <p className="deployment-sudo-hint">{t('deployment.sudoHint')}</p>}
            <div className="deployment-shell-help"><span>{t('deployment.variableHint')}</span><code>{t('deployment.shellExample')}</code></div>
            <div className="deployment-variable-grid">{deploymentVariables.map((variable) => <button type="button" className="deployment-variable" key={variable.name} onClick={() => insertShellVariable(variable.name)} aria-label={`${t('deployment.insertVariable')} {{${variable.name}}}`}><span className="deployment-variable-name"><code>{`{{${variable.name}}}`}</code><CirclePlus size={15} /></span><span className="deployment-variable-description">{t(variable.descriptionKey)}</span></button>)}</div>
            {profile.shellTemplate.trim() && <><label className="check-label"><input type="checkbox" checked={profile.confirmManual} onChange={(event) => set('confirmManual', event.target.checked)} />{t('deployment.confirmManual')}</label><p className="deployment-upload-hint">{t('deployment.confirmManualHint')}</p></>}
          </div>
        </details>
        <details ref={scheduleDetailsRef} className="deployment-setting-card deployment-optional" key={profile.id + '-schedule'}>
          <summary><span>{t('deployment.schedule')}</span>{profile.schedule.enabled && <small>{t('deployment.scheduleSummary', { time: profile.schedule.dailyTime })}</small>}</summary>
          <div className="deployment-optional-body deployment-schedule"><label className="check-label"><input type="checkbox" checked={profile.schedule.enabled} onChange={(event) => set('schedule', { ...profile.schedule, enabled: event.target.checked })} />{t('deployment.schedule')}</label><input ref={scheduleTimeRef} type="time" disabled={!profile.schedule.enabled} aria-invalid={Boolean(fieldIssue('schedule'))} value={profile.schedule.dailyTime} onChange={(event) => set('schedule', { ...profile.schedule, dailyTime: event.target.value })} />{fieldIssue('schedule') && <small className="deployment-field-error">{fieldIssue('schedule')}</small>}</div>
        </details>
        <details ref={hookDetailsRef} className="deployment-setting-card deployment-optional" key={profile.id + '-hook'}>
          <summary><span>{t('deployment.hook')}</span>{profile.hookUrl?.trim() && <small>{profile.hookTemplate === 'feishu' ? t('deployment.hookFeishu') : t('deployment.hookCustom')}</small>}</summary>
          <div className="deployment-optional-body">
            <p className="deployment-upload-hint">{t('deployment.hookHint')}</p>
            <label className="deployment-hook-url">{t('deployment.hookUrl')}<input ref={hookUrlRef} type="url" value={profile.hookUrl ?? ''} aria-invalid={Boolean(fieldIssue('hookUrl'))} placeholder="https://" onChange={(event) => set('hookUrl', event.target.value)} />{fieldIssue('hookUrl') && <small className="deployment-field-error">{fieldIssue('hookUrl')}</small>}</label>
            <div className="deployment-hook-template" role="group" aria-label={t('deployment.hookTemplate')}><button type="button" className={profile.hookTemplate === 'feishu' ? 'selected' : ''} aria-pressed={profile.hookTemplate === 'feishu'} onClick={() => set('hookTemplate', 'feishu')}>{t('deployment.hookFeishu')}</button><button type="button" className={profile.hookTemplate === 'custom' ? 'selected' : ''} aria-pressed={profile.hookTemplate === 'custom'} onClick={() => set('hookTemplate', 'custom')}>{t('deployment.hookCustom')}</button></div>
            {profile.hookTemplate === 'feishu' ? <p className="deployment-hook-help">{t('deployment.hookFeishuHint')}</p> : <><label className="deployment-hook-body">{t('deployment.hookBody')}<textarea ref={hookEditorRef} rows={6} value={profile.hookBody ?? ''} aria-invalid={Boolean(fieldIssue('hookBody'))} placeholder={'{\n  "text": {{summary}},\n  "success": {{succeeded}}\n}'} onChange={(event) => set('hookBody', event.target.value)} spellCheck={false} />{fieldIssue('hookBody') && <small className="deployment-field-error">{fieldIssue('hookBody')}</small>}</label><div className="deployment-variable-heading"><strong>{t('deployment.hookVariablesTitle')}</strong><span>{t('deployment.hookVariables')}</span></div><div className="deployment-hook-variable-grid">{deploymentHookVariables.map((variable) => <button type="button" className="deployment-variable" key={variable.name} onClick={() => insertHookVariable(variable.name)} aria-label={`${t('deployment.insertVariable')} {{${variable.name}}}：${t(variable.descriptionKey)}`}><span className="deployment-variable-name"><code title={`{{${variable.name}}}`}>{`{{${variable.name}}}`}</code><CirclePlus size={15} /></span><span className="deployment-variable-description">{t(variable.descriptionKey)}</span></button>)}</div></>}
          </div>
        </details>
      </section>
    </div>
    {view === 'preview' && previewData && <div className="deployment-flow deployment-review-view"><div className="deployment-view-heading"><button type="button" className="text-button" onClick={() => { setViewRunId(null); setView('deploy') }}><ArrowRight size={14} />{t('deployment.backToEdit')}</button><strong>{t('deployment.preview')}</strong><span>{t('deployment.selected', { count: previewData.files.length, size: formatFileSize(previewData.totalSize) })}</span></div><section className="deployment-section deployment-preview" ref={previewRef}>
        {profile.archiveEnabled && <p className="deployment-preview-note">{t('deployment.previewNoArchiveHint')}</p>}
        <div className="deployment-preview-paths"><div className="deployment-path"><strong>{t('deployment.remoteTarget')}</strong><code>{previewData.remoteTargetDirectory}</code></div>{archiveDestination && <div className="deployment-path"><strong>{t('deployment.archivePath')}</strong><code>{archiveDestination}</code></div>}</div>
        <div className="deployment-preview-tree-panel"><header><strong>{t('deployment.fileTree')}</strong><span>{profile.archiveEnabled ? t('deployment.archiveTreeHint') : t('deployment.filesTreeHint')}</span></header><DeploymentPreviewTree files={previewData.files} root={previewData.archiveFileName ?? previewData.remoteTargetDirectory} archive={Boolean(previewData.archiveFileName)} /></div>
        <p className="deployment-overwrite-hint">{t('deployment.overwriteHint')}</p>
        {previewData.commandPreview && <details className="deployment-preview-details"><summary>{t('deployment.expandedCommand')}</summary><pre className="deployment-code">{previewData.commandPreview}</pre></details>}
      </section></div>}
    {view === 'run' && <div className="deployment-flow deployment-run-view"><div className="deployment-view-heading"><button type="button" className="text-button" onClick={() => { setViewRunId(null); setView('deploy') }}><ArrowRight size={14} />{t('deployment.backToEdit')}</button><strong>{t('deployment.runView')}</strong></div>{deploymentProgress && <div className="deployment-run-progress" role="status"><span>{t(`deployment.progress.${deploymentProgress.phase}`)}{deploymentProgress.bytesTotal ? ` · ${formatFileSize(deploymentProgress.bytesProcessed)}/${formatFileSize(deploymentProgress.bytesTotal)}` : ''}</span><progress value={deploymentPercent} max={100} aria-label={t('deployment.runProgress')} /></div>}{shownRun ? renderRunResult(shownRun, resultRef) : <p className="deployment-preview-note">{t('deployment.runStarting')}</p>}<p className="deployment-preview-note">{t('deployment.runInBackgroundHint')}</p></div>}
    {view === 'history' && <div className="deployment-flow deployment-history-view">
      <div className="deployment-history-toolbar"><button className="secondary-button" onClick={() => void refreshRuns().catch((error) => onError(errorMessage(error)))}>{t('deployment.refresh')}</button><button className="secondary-button" disabled={selectedRuns.size === 0} onClick={async () => { const accepted = await onConfirm({ title: t('deployment.deleteHistory'), message: t('deployment.localDeleteOnly'), kind: 'danger', confirmLabel: t('deployment.deleteHistory') }); if (!accepted) return; try { await window.api.deployments.runsRemove([...selectedRuns]); setSelectedRuns(new Set()); setHistoryRun(null); await refreshRuns() } catch (error) { onError(errorMessage(error)) } }}>{t('deployment.deleteHistory')}</button></div>
      <div className="deployment-history">{runs.length === 0 ? <p className="deployment-history-empty">{t('deployment.noHistory')}</p> : runs.map((item) => <div className="deployment-history-row" key={item.id}>
        <input type="checkbox" checked={selectedRuns.has(item.id)} onChange={(event) => setSelectedRuns((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next })} />
        <button className="deployment-history-entry" onClick={() => { void window.api.deployments.runGet(item.id).then((next) => { setHistoryRun(next); window.requestAnimationFrame(() => historyResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }).catch((error) => onError(errorMessage(error))) }}><time>{new Date(item.startedAt).toLocaleString()}</time><span className={'deployment-run-status ' + item.status}>{statusText[item.status] ?? item.status}</span><span className="deployment-history-meta">{item.triggerType === 'scheduled' ? t('deployment.scheduled') : item.triggerType === 'api' ? t('deployment.api') : t('deployment.manual')} · {t('deployment.filesCount')}: {item.selectedFileCount} · {t('deployment.duration')}: {item.finishedAt ? Math.round((Date.parse(item.finishedAt) - Date.parse(item.startedAt)) / 1000) + 's' : '…'} · {t('deployment.exitCode')}: {item.commandExitCode ?? '—'}</span></button>
        {!['succeeded', 'failed', 'cancelled'].includes(item.status) && <button className="icon-button" title={t('deployment.cancelRun')} onClick={() => void cancel(item.id)}><X size={14} /></button>}
      </div>)}</div>
      {historyRun && renderRunResult(historyRun, historyResultRef)}
    </div>}
    <div className="deployment-footer">
      {(view === 'deploy' || view === 'preview') && <div className="deployment-footer-preview">
        <button className="secondary-button" title={previewData ? t('deployment.previewAgainHint') : undefined} disabled={busy} onClick={() => void preview()}>{previewData ? t('deployment.previewAgain') : t('deployment.previewUpload')}</button>
        {previewProgress ? <div className="deployment-progress" role="status">
          <span>{previewProgress.phase === 'scanning' ? t('deployment.previewScanning') : `${t('deployment.previewHashing')} ${progressPercent}% · ${previewProgress.filesProcessed}/${previewProgress.filesTotal} · ${formatFileSize(previewProgress.bytesProcessed)}/${formatFileSize(previewProgress.bytesTotal)}`}</span>
          <progress value={progressMaximum ? progressValue : undefined} max={progressMaximum || undefined} aria-label={t('deployment.previewProgress')} />
        </div> : view === 'deploy' && <small className={visibleIssues.length ? 'deployment-footer-error' : 'deployment-footer-hint'}>{visibleIssues[0]?.message ?? t('deployment.previewOptionalHint')}</small>}
      </div>}
      <div className="deployment-footer-actions">
        <button className="secondary-button" onClick={() => void requestClose()}>{t('common.close')}</button>
        {view === 'deploy' && <>
          <button className="secondary-button" disabled={busy} onClick={() => void saveTask()}>{t('deployment.save')}</button>
          <button className="primary-button" disabled={busy} onClick={() => void execute()}><Rocket size={15} />{busy ? t('deployment.running') : t('deployment.run')}</button>
        </>}
        {view === 'preview' && <button className="primary-button" disabled={busy} onClick={() => void execute()}><Rocket size={15} />{t('deployment.run')}</button>}
        {view === 'run' && shownRun && !['succeeded', 'failed', 'cancelled', 'awaiting-confirmation'].includes(shownRun.status) && <button className="danger-button" onClick={() => void cancel(shownRun.id)}>{t('deployment.cancelRun')}</button>}
      </div>
    </div>
    {editorExpanded && <div className="deployment-editor-overlay" role="dialog" aria-modal="true" aria-label={t('deployment.shellCommand')} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); toggleEditorExpanded() } }}>
      <div className="deployment-editor-header"><strong>{t('deployment.shellCommand')}</strong><button type="button" className="secondary-button" onClick={() => setAiComposerOpen(true)}><WandSparkles size={15} />{t('deployment.aiAssist')}</button></div>
      <div className="deployment-editor-large-wrap"><textarea ref={shellEditorRef} className="deployment-editor-large" value={profile.shellTemplate} onChange={(event) => set('shellTemplate', event.target.value)} spellCheck={false} aria-label={t('deployment.shellCommand')} /><button type="button" className="icon-button deployment-editor-corner-button" title={t('deployment.collapseEditor')} aria-label={t('deployment.collapseEditor')} aria-expanded={editorExpanded} onClick={toggleEditorExpanded}><Minimize2 size={17} /></button></div>
      <div className="deployment-editor-bottom"><p>{t('deployment.variableHint')}</p><div className="deployment-editor-variables">{deploymentVariables.map((variable) => <button type="button" className="secondary-button" key={variable.name} title={t(variable.descriptionKey)} onClick={() => insertShellVariable(variable.name)}>{`{{${variable.name}}}`}</button>)}</div>{profile.shellTemplate.trim() && <label className="check-label"><input type="checkbox" checked={profile.confirmManual} onChange={(event) => set('confirmManual', event.target.checked)} />{t('deployment.confirmManual')}</label>}</div>
    </div>}
    {aiComposerOpen && <DeploymentAiComposer archiveEnabled={profile.archiveEnabled} archiveFormat={profile.archiveFormat ?? 'zip'} hasCommand={Boolean(profile.shellTemplate.trim())} settings={aiSettings} onSettings={onOpenAiSettings} onClose={closeAiComposer} onUse={(command) => { set('shellTemplate', command); closeAiComposer() }} />}
    {importBundle && <DeploymentImportDialog bundle={importBundle} target={bookmark} onClose={() => setImportBundle(null)} onImported={(items) => { const first = items[0]; if (!first) return; setProfiles((current) => [...items, ...current]); switchProfile(first); setImportBundle(null); onNotice(t('deployment.importedTasks', { count: items.length })) }} onError={onError} />}
  </div></Modal>
}

function SettingsDialog({ initialSection, settings, backgroundImage, appIcons, uiTheme, appLanguage, aiSettings, onAiSettingsChange, onThemePreview, onLanguagePreview, onClose, onSave, onConfirm, onNotice, onError, raised = false }: { initialSection: SettingsSection; settings: TerminalSettings; backgroundImage: string; appIcons: AppIconSettings; uiTheme: UiTheme; appLanguage: AppLanguage; aiSettings: AiSettings; onAiSettingsChange(settings: AiSettings): void; onThemePreview(theme: UiTheme): void; onLanguagePreview(language: AppLanguage): void; onClose(): void; onSave(settings: TerminalSettings, backgroundImage: string, appIcon: AppIconId, uiTheme: UiTheme, appLanguage: AppLanguage, ai: AiSettingsInput): void; onConfirm: ConfirmAction; onNotice(message: string): void; onError(message: string): void; raised?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [form, setForm] = useState<TerminalSettings>({ ...settings })
  const [previewImage, setPreviewImage] = useState(backgroundImage)
  const [appIcon, setAppIcon] = useState(appIcons.selected)
  const [theme, setTheme] = useState(uiTheme)
  const [language, setDialogLanguage] = useState(appLanguage)
  const [aiForm, setAiForm] = useState<AiSettings>({ ...aiSettings })
  const [apiKey, setApiKey] = useState('')
  const [testingAi, setTestingAi] = useState(false)
  const [aiTested, setAiTested] = useState(false)
  const [webApiStatus, setWebApiStatus] = useState<WebApiStatus | null>(null)
  const [webApiConfig, setWebApiConfig] = useState<WebApiConfig | null>(null)
  const [webApiReferenceOpen, setWebApiReferenceOpen] = useState(false)
  const [savingWebApi, setSavingWebApi] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [diagnosticPath, setDiagnosticPath] = useState('')
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)
  const [manualFontMode, setManualFontMode] = useState(false)
  const [manualFontName, setManualFontName] = useState(() => primaryFontName(settings.fontFamily))
  const set = <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]): void => setForm((current) => ({ ...current, [key]: value }))
  const setAi = <K extends keyof AiSettings>(key: K, value: AiSettings[K]): void => { setAiTested(false); setAiForm((current) => ({ ...current, [key]: value })) }
  const aiInput = (): AiSettingsInput => ({ baseUrl: aiForm.baseUrl, model: aiForm.model, defaultShell: aiForm.defaultShell, provider: aiForm.provider, thinkingMode: aiForm.thinkingMode, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
  const selectTheme = (value: UiTheme): void => { setTheme(value); onThemePreview(value) }
  useEffect(() => {
    if (section !== 'terminal' || systemFonts !== null) return
    let active = true
    void window.api.settings.listSystemFonts()
      .then((fonts) => { if (active) setSystemFonts(fonts) })
      .catch(() => { if (active) setSystemFonts([]) })
    return () => { active = false }
  }, [section, systemFonts])
  useEffect(() => {
    if (section !== 'webApi' || webApiStatus) return
    let active = true
    void window.api.webApi.get().then((status) => { if (active) { setWebApiStatus(status); setWebApiConfig(status.config) } }).catch((error) => { if (active) onError(errorMessage(error)) })
    return () => { active = false }
  }, [section, webApiStatus])
  const saveWebApi = async (): Promise<void> => {
    if (!webApiConfig) return
    setSavingWebApi(true)
    try { await window.api.webApi.save(webApiConfig); onNotice(t('webApi.saved')); onClose() }
    catch (error) { onError(errorMessage(error)); void window.api.webApi.get().then(setWebApiStatus).catch(() => {}) }
    finally { setSavingWebApi(false) }
  }
  const regenerateWebApiToken = async (): Promise<void> => {
    if (!await onConfirm({ title: t('webApi.regenerateToken'), message: t('webApi.regenerateConfirm'), kind: 'warning', confirmLabel: t('webApi.regenerateToken') })) return
    try { setWebApiStatus(await window.api.webApi.regenerateToken()); onNotice(t('webApi.tokenRegenerated')) }
    catch (error) { onError(errorMessage(error)) }
  }
  const chooseBackground = async (): Promise<void> => {
    try {
      const path = await window.api.settings.chooseTerminalBackground()
      if (!path) return
      const image = await window.api.settings.loadTerminalBackground(path)
      set('backgroundImagePath', path)
      setPreviewImage(image)
    } catch (error) { onError(errorMessage(error)) }
  }
  const testAi = async (): Promise<void> => {
    setTestingAi(true); setAiTested(false)
    try { await window.api.ai.testSettings(aiInput()); setAiTested(true) }
    catch (error) { onError(errorMessage(error)) }
    finally { setTestingAi(false) }
  }
  const deleteAiKey = async (): Promise<void> => {
    if (!await onConfirm({ title: t('common.deleteApiKey'), message: t('app.deleteTheSavedAiApiKey'), detail: t('app.youWillNeedToEnterTheKeyAgain'), kind: 'danger', confirmLabel: t('common.deleteApiKey') })) return
    try { const saved = await window.api.ai.deleteApiKey(); setApiKey(''); setAiForm((current) => ({ ...current, apiKeyConfigured: saved.apiKeyConfigured })); onAiSettingsChange(saved) }
    catch (error) { onError(errorMessage(error)) }
  }
  const checkForUpdates = async (): Promise<void> => {
    setCheckingUpdates(true)
    try {
      const result = await window.api.system.checkForUpdates()
      if (!result.updateAvailable) {
        onNotice(t('app.alreadyLatestVersion', { value0: result.currentVersion }))
        return
      }
      const openRelease = await onConfirm({
        title: t('app.updateAvailable'),
        message: t('app.newVersionAvailable', { value0: result.latestVersion }),
        detail: t('app.currentVersionValue', { value0: result.currentVersion }),
        kind: 'warning',
        confirmLabel: t('app.openReleasePage')
      })
      if (openRelease) await window.api.system.openExternal(result.releaseUrl)
    } catch (error) { onError(errorMessage(error)) }
    finally { setCheckingUpdates(false) }
  }
  const themeOptions: { value: UiTheme; label: string; icon: typeof Monitor }[] = [{ value: 'system', label: t('app.system'), icon: Monitor }, { value: 'light', label: t('app.light'), icon: Sun }, { value: 'dark', label: t('app.dark'), icon: Moon }]
  const providerOptions: { value: AiProvider; label: string }[] = [{ value: 'auto', label: t('app.autoDetect') }, { value: 'openAi', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'qwen', label: 'Qwen' }, { value: 'deepSeek', label: 'DeepSeek' }, { value: 'kimi', label: 'Kimi' }, { value: 'glm', label: 'GLM' }, { value: 'miniMax', label: 'MiniMax' }, { value: 'grok', label: 'Grok' }, { value: 'gemini', label: 'Gemini' }]
  const providerClue = `${aiForm.provider} ${aiForm.baseUrl} ${aiForm.model}`.toLowerCase()
  const thinkingCannotDisable = providerClue.includes('grok') || providerClue.includes('api.x.ai') || providerClue.includes('kimi-k3') || providerClue.includes('k2.7') || providerClue.includes('gemini-3') || (providerClue.includes('gemini-2.5') && providerClue.includes('pro'))
  const thinkingHint = aiForm.thinkingMode === 'default' ? t('app.noThinkingControlsAreSentTheServiceDecides') : thinkingCannotDisable && aiForm.thinkingMode === 'disabled' ? t('app.thisModelCannotFullyDisableThinkingTheLowest') : t('app.theSelectedControlIsSentWithConnectionTests')
  const currentFontName = primaryFontName(form.fontFamily)
  const installedFonts = (systemFonts ?? []).filter((font) => font.toLocaleLowerCase() !== 'jetbrains mono')
  const installedFont = installedFonts.find((font) => font.toLocaleLowerCase() === currentFontName.toLocaleLowerCase())
  const fontChoice = manualFontMode ? '__manual__' : currentFontName === 'JetBrains Mono' ? '__bundled__' : currentFontName === 'monospace' ? '__system__' : systemFonts === null ? '__current__' : installedFont ?? '__manual__'
  return <><Modal title={t('common.settings')} onClose={webApiReferenceOpen ? () => undefined : onClose} wide raised={raised} className="settings-dialog"><form className="form-grid terminal-settings-form" onSubmit={(event) => { event.preventDefault(); if (section === 'webApi') { void saveWebApi(); return } onSave(form, previewImage, appIcon, theme, language, aiInput()) }}>
    <div className="settings-tabs" role="tablist" aria-label={t('app.settingsCategories')}><button type="button" role="tab" aria-selected={section === 'appearance'} className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}><Palette size={15} />{t('app.appearance')}</button><button type="button" role="tab" aria-selected={section === 'terminal'} className={section === 'terminal' ? 'active' : ''} onClick={() => setSection('terminal')}><SquareTerminal size={15} />{t('common.terminal')}</button><button type="button" role="tab" aria-selected={section === 'ai'} className={section === 'ai' ? 'active' : ''} onClick={() => setSection('ai')}><Bot size={15} />AI</button><button type="button" role="tab" aria-selected={section === 'webApi'} className={section === 'webApi' ? 'active' : ''} onClick={() => setSection('webApi')}><Network size={15} />Web API</button><button type="button" role="tab" aria-selected={section === 'about'} className={section === 'about' ? 'active' : ''} onClick={() => setSection('about')}><Info size={15} />{t('app.about')}</button></div>
    <div className={`settings-content ${section}`}>
    {section === 'appearance' ? <><fieldset className="ui-theme-settings"><legend>{t('common.theme')}</legend><div className="theme-options" role="radiogroup" aria-label={t('common.theme')}>{themeOptions.map((option) => { const Icon = option.icon; return <button key={option.value} type="button" role="radio" aria-checked={theme === option.value} className={theme === option.value ? 'active' : ''} onClick={() => selectTheme(option.value)}><Icon size={17} /><span>{option.label}</span></button> })}</div></fieldset><fieldset className="ui-theme-settings"><legend>{t('common.language')}</legend><div className="theme-options" role="radiogroup" aria-label={t('common.language')}>{availableLanguages.map((option) => <button key={option.code} type="button" role="radio" aria-checked={language === option.code} className={language === option.code ? 'active' : ''} onClick={() => { setDialogLanguage(option.code); onLanguagePreview(option.code) }}><Languages size={17} /><span>{option.label}</span></button>)}</div></fieldset><fieldset className="app-icon-settings"><legend>{t('app.appIcon')}</legend><div className="app-icon-options">{appIcons.options.map((icon) => <label key={icon.id} className={appIcon === icon.id ? 'selected' : ''}><input type="radio" name="app-icon" checked={appIcon === icon.id} onChange={() => setAppIcon(icon.id)} /><img src={icon.dataUrl} alt="" /><span>{t(appIconMessageKeys[icon.id])}</span></label>)}</div></fieldset><section className="diagnostic-section"><strong>{t('app.diagnostics')}</strong><div className="diagnostic-export"><button type="button" className="secondary-button" onClick={async () => { try { const path = await window.api.diagnostics.export(); if (path) setDiagnosticPath(path) } catch (error) { onError(errorMessage(error)) } }}><FileInput size={15} />{t('app.exportDiagnostics')}</button>{diagnosticPath && <small title={diagnosticPath}>{diagnosticPath}</small>}</div></section></> : section === 'about' ? <div className="about-settings">
      <div className="about-product"><img src={appIcons.options.find((icon) => icon.id === appIcon)?.dataUrl} alt="" /><div><h2>Luna Remote</h2><span>{t('app.versionValue', { value0: window.api.appVersion })}</span></div></div>
      <p>{t('app.aboutDescription')}</p>
      <div className="about-actions"><button type="button" className="primary-button" disabled={checkingUpdates} onClick={() => void checkForUpdates()}>{checkingUpdates ? t('app.checkingForUpdates') : t('app.checkForUpdates')}</button><button type="button" className="secondary-button" onClick={() => void window.api.system.openExternal(repositoryUrl).catch((error) => onError(errorMessage(error)))}><ExternalLink size={15} />{t('app.viewSourceCode')}</button></div>
      <div className="about-meta"><span>{t('app.openSourceLicense')}</span></div>
    </div> : section === 'ai' ? <div className="ai-settings">
      <label>API Base URL<input required type="url" value={aiForm.baseUrl} onChange={(event) => setAi('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" /></label>
      <label>{t('app.model')}<input value={aiForm.model} onChange={(event) => setAi('model', event.target.value)} placeholder="gpt-5" /></label>
      <label>API Key<div className="input-button"><input type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setAiTested(false) }} placeholder={aiForm.apiKeyConfigured ? t('app.savedSecurelyLeaveBlankToKeepIt') : t('common.optional')} /><button type="button" className="icon-button danger" title={t('app.deleteSavedApiKey')} disabled={!aiForm.apiKeyConfigured} onClick={() => void deleteAiKey()}><Trash2 size={15} /></button></div></label>
      <label>{t('app.defaultTargetShell')}<select value={aiForm.defaultShell} onChange={(event) => setAi('defaultShell', event.target.value as AiShell)}><option value="linux">Linux Shell</option><option value="powerShell">PowerShell</option><option value="cmd">Windows cmd</option><option value="macos">macOS Shell</option></select></label>
      <div className="ai-provider-row"><label>{t('app.provider')}<select value={aiForm.provider} onChange={(event) => setAi('provider', event.target.value as AiProvider)}>{providerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>{t('app.thinkingMode')}<select value={aiForm.thinkingMode} onChange={(event) => setAi('thinkingMode', event.target.value as AiThinkingMode)}><option value="default">{t('app.modelDefault')}</option><option value="disabled">{t('app.minimize')}</option><option value="enabled">{t('app.enabled')}</option></select></label></div>
      <small className="ai-thinking-hint">{thinkingHint}</small>
      <div className="ai-settings-test"><button type="button" className="secondary-button" disabled={testingAi || !aiForm.model.trim()} onClick={() => void testAi()}>{testingAi ? t('app.testing') : t('app.testConnection')}</button>{aiTested && <span><Check size={14} />{t('app.connected2')}</span>}</div>
    </div> : section === 'webApi' ? <div className="web-api-settings">
      {webApiConfig ? <>
        <div className="web-api-intro"><span className="web-api-intro-icon"><Network size={19} /></span><div><strong>Web API</strong><p>{t('webApi.description')}</p></div><span className={`web-api-indicator ${webApiStatus?.running ? 'running' : ''}`}>{webApiStatus?.running ? t('webApi.running') : t('webApi.stopped')}</span></div>
        {webApiStatus?.error && <p className="web-api-error">{webApiStatus.error}</p>}
        <section className="web-api-card">
          <div className="web-api-card-heading"><div><strong>{t('webApi.service')}</strong><small>{t('webApi.serviceHint')}</small></div><label className="web-api-switch"><input type="checkbox" aria-label={t('webApi.enable')} checked={webApiConfig.enabled} onChange={(event) => setWebApiConfig({ ...webApiConfig, enabled: event.target.checked })} /><span /></label></div>
          {webApiConfig.enabled && <>
            <div className="web-api-fields"><div className="web-api-field"><strong>{t('webApi.listenScope')}</strong><div className="web-api-segment" role="radiogroup" aria-label={t('webApi.listenScope')}><button type="button" role="radio" aria-checked={!webApiConfig.allowRemote} className={!webApiConfig.allowRemote ? 'selected' : ''} onClick={() => setWebApiConfig({ ...webApiConfig, allowRemote: false })}>{t('webApi.localOnly')}</button><button type="button" role="radio" aria-checked={webApiConfig.allowRemote} className={webApiConfig.allowRemote ? 'selected' : ''} onClick={() => setWebApiConfig({ ...webApiConfig, allowRemote: true })}>{t('webApi.network')}</button></div></div><label className="web-api-field"><strong>{t('webApi.port')}</strong><input type="number" min="1" max="65535" value={webApiConfig.port} onChange={(event) => setWebApiConfig({ ...webApiConfig, port: Number(event.target.value) })} /></label></div>
            <div className="web-api-address"><span>{t('webApi.address')}</span><code>{`http://${webApiConfig.allowRemote ? `<${t('webApi.hostPlaceholder')}>` : '127.0.0.1'}:${webApiConfig.port}/api/v1`}</code></div>
          </>}
        </section>
        {webApiConfig.enabled && <section className="web-api-card web-api-token-card"><div className="web-api-card-heading"><div><strong>{t('webApi.token')}</strong><small>{t('webApi.tokenHint')}</small></div></div>{webApiStatus?.token ? <div className="web-api-token-actions"><code aria-label={t('webApi.token')}>••••••••••••••••••••••••</code><button type="button" className="secondary-button" onClick={() => void window.api.system.writeClipboard(webApiStatus.token ?? '').then(() => onNotice(t('webApi.copied'))).catch((error) => onError(errorMessage(error)))}><Copy size={14} />{t('common.copy')}</button><button type="button" className="text-button" onClick={() => void regenerateWebApiToken()}>{t('webApi.regenerateToken')}</button></div> : <p className="web-api-token-pending">{t('webApi.tokenPending')}</p>}</section>}
        <button type="button" className="secondary-button web-api-reference-open" onClick={() => setWebApiReferenceOpen(true)}><FileJson2 size={15} />{t('webApi.viewEndpoints')}</button>
      </> : <p>{t('webApi.loading')}</p>}
    </div> : <>
      <div className="terminal-preview" style={terminalBackgroundStyle(form, previewImage)}><div style={{ color: form.foregroundColor, background: colorWithOpacity(form.backgroundColor, form.backgroundOpacity), fontFamily: form.fontFamily, fontSize: form.fontSize }}><span>user@host:~$</span> ls -la<br />drwxr-xr-x&nbsp;&nbsp;projects</div></div>
      <label>{t('app.font')}<div className={`terminal-font-picker ${fontChoice === '__manual__' ? 'manual' : ''}`}><select value={fontChoice} onChange={(event) => { const value = event.target.value; if (value === '__manual__') { setManualFontMode(true); setManualFontName(currentFontName); return } setManualFontMode(false); if (value === '__bundled__') { set('fontFamily', BUNDLED_TERMINAL_FONT); setManualFontName('JetBrains Mono'); return } if (value === '__system__') { set('fontFamily', 'monospace'); setManualFontName('monospace'); return } set('fontFamily', terminalFontStack(value)); setManualFontName(value) }}><option value="__bundled__">JetBrains Mono {t('app.bundled')}</option><option value="__system__">{t('app.systemMonospace')}</option>{systemFonts === null && !['JetBrains Mono', 'monospace'].includes(currentFontName) && <option value="__current__">{currentFontName} {t('app.current')}</option>}{installedFonts.map((font) => <option key={font} value={font}>{font}</option>)}<option value="__manual__">{t('app.enterAnotherFont')}</option></select>{fontChoice === '__manual__' && <input autoFocus value={manualFontName} placeholder={t('app.fontName')} onChange={(event) => { const value = event.target.value; setManualFontName(value); if (value.trim()) set('fontFamily', terminalFontStack(value)) }} />}</div></label>
      <label>{t('app.fontSize')}<div className="range-control"><input type="range" min="10" max="30" step="1" value={form.fontSize} style={{ '--range-progress': `${((form.fontSize - 10) / 20) * 100}%` } as React.CSSProperties} onChange={(event) => set('fontSize', Number(event.target.value))} /><output>{form.fontSize} px</output></div></label>
      <div className="color-settings"><label>{t('app.textColor')}<div className="color-control"><input type="color" value={form.foregroundColor} onChange={(event) => set('foregroundColor', event.target.value)} /><span>{form.foregroundColor}</span></div></label><label>{t('app.backgroundColor')}<div className="color-control"><input type="color" value={form.backgroundColor} onChange={(event) => set('backgroundColor', event.target.value)} /><span>{form.backgroundColor}</span></div></label></div>
      <label>{t('app.backgroundOpacity')}<div className="range-control"><input type="range" min="0" max="1" step="0.05" value={form.backgroundOpacity} style={{ '--range-progress': `${form.backgroundOpacity * 100}%` } as React.CSSProperties} onChange={(event) => set('backgroundOpacity', Number(event.target.value))} /><output>{Math.round(form.backgroundOpacity * 100)}%</output></div></label>
      <label>{t('app.backgroundImage')}<div className="input-button background-image-input"><input readOnly value={form.backgroundImagePath} placeholder={t('app.noneSelected')} /><button type="button" className="secondary-button" onClick={() => void chooseBackground()}><ImageIcon size={15} />{t('common.choose')}</button><button type="button" className="icon-button background-clear" title={t('app.clearBackgroundImage')} disabled={!form.backgroundImagePath} onClick={() => { set('backgroundImagePath', ''); setPreviewImage('') }}><Trash2 size={15} /></button></div></label>
      <label>{t('app.imageFit')}<select value={form.backgroundImageFit} onChange={(event) => set('backgroundImageFit', event.target.value as TerminalSettings['backgroundImageFit'])}><option value="cover">{t('app.cover')}</option><option value="contain">{t('app.contain')}</option><option value="stretch">{t('app.stretch')}</option><option value="tile">{t('app.tile')}</option></select></label>
    </>}
    </div>
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{section === 'about' ? t('common.close') : t('common.cancel')}</button>{section === 'webApi' ? <button className="primary-button" type="button" disabled={!webApiConfig || savingWebApi} onClick={() => void saveWebApi()}>{t('common.save')}</button> : section !== 'about' && <button className="primary-button" type="submit">{t('common.save')}</button>}</div>
  </form></Modal>{webApiReferenceOpen && webApiStatus && <WebApiReferenceDialog config={webApiStatus.config} chinese={language.startsWith('zh')} onClose={() => setWebApiReferenceOpen(false)} onNotice={onNotice} onError={onError} />}</>
}

function WebApiReferenceDialog({ config, chinese, onClose, onNotice, onError }: { config: WebApiConfig; chinese: boolean; onClose(): void; onNotice(message: string): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState('')
  const baseUrl = `http://${config.allowRemote ? '<host-ip>' : '127.0.0.1'}:${config.port}/api/v1`
  const copy = async (value: string): Promise<void> => {
    try { await window.api.system.writeClipboard(value); onNotice(t('webApi.referenceCopied')) }
    catch (error) { onError(errorMessage(error)) }
  }
  return <Modal title={t('webApi.endpointList')} onClose={onClose} wide raised className="web-api-reference-dialog"><div className="web-api-reference-content">
    <div className="web-api-reference-top"><div><span>Base URL</span><code>{baseUrl}</code></div><button type="button" className="secondary-button" onClick={() => void copy(formatWebApiReference(baseUrl, chinese))}><Copy size={14} />{t('webApi.copyAllEndpoints')}</button></div>
    <p className="web-api-reference-auth">Authorization: Bearer &lt;token&gt; <span>·</span> {t('webApi.referenceErrorFormat')}</p>
    <div className="web-api-reference-list">{webApiEndpoints.map((endpoint) => {
      const key = `${endpoint.method} ${endpoint.path}`
      const open = expanded === key
      return <article key={key} className={open ? 'expanded' : ''}><div className="web-api-reference-row"><button type="button" className="web-api-reference-toggle" aria-expanded={open} onClick={() => setExpanded(open ? '' : key)}><span className={`web-api-method ${endpoint.method.toLowerCase()}`}>{endpoint.method}</span><code>{endpoint.path}</code><span className="web-api-reference-description">{chinese ? endpoint.descriptionZh : endpoint.descriptionEn}</span>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button><button type="button" className="icon-button" title={t('webApi.copyEndpoint')} aria-label={`${t('webApi.copyEndpoint')} ${endpoint.method} ${endpoint.path}`} onClick={() => void copy(formatWebApiEndpoint(endpoint, chinese, baseUrl))}><Copy size={14} /></button></div>
        {open && <div className="web-api-reference-detail"><section><strong>{t('webApi.requestFormat')}</strong><pre>{endpoint.request}</pre></section><section><strong>{t('webApi.responseFormat')}</strong><pre>{endpoint.response}</pre></section>{endpoint.types && <section><strong>{t('webApi.fieldTypes')}</strong><pre>{endpoint.types}</pre></section>}{(chinese ? endpoint.noteZh : endpoint.noteEn) && <p>{chinese ? endpoint.noteZh : endpoint.noteEn}</p>}</div>}
      </article>
    })}</div>
    <div className="dialog-actions"><button type="button" className="primary-button" onClick={onClose}>{t('common.close')}</button></div>
  </div></Modal>
}

function GroupNameDialog({ mode, initialName, onClose, onSave }: { mode: 'create' | 'rename'; initialName: string; onClose(): void; onSave(name: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const [name, setName] = useState(initialName)
  return <Modal title={mode === 'create' ? t('common.newGroup') : t('common.renameGroup')} onClose={onClose}><form className="form-grid compact-form" onSubmit={(event) => { event.preventDefault(); onSave(name.trim()) }}>
    <label>{t('app.groupName')}<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder={t('app.forExampleProduction')} /></label>
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button type="submit" className="primary-button">{t('common.save')}</button></div>
  </form></Modal>
}

function BookmarkDialog({ bookmark, connections, groups, onClose, onSaved, onError }: { bookmark?: Bookmark; connections: Bookmark[]; groups: string[]; onClose(): void; onSaved(): void; onError(message: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const [form, setForm] = useState<BookmarkInput>(bookmark ? { name: bookmark.name, host: bookmark.host, port: bookmark.port, username: bookmark.username, authType: bookmark.authType, privateKeyPath: bookmark.privateKeyPath, jumpBookmarkId: bookmark.jumpBookmarkId, groupName: bookmark.groupName, favorite: bookmark.favorite, keepaliveEnabled: bookmark.keepaliveEnabled, keepaliveIntervalSeconds: bookmark.keepaliveIntervalSeconds, keepaliveCountMax: bookmark.keepaliveCountMax, note: bookmark.note } : emptyBookmark)
  const set = <K extends keyof BookmarkInput>(key: K, value: BookmarkInput[K]): void => setForm((current) => ({ ...current, [key]: value }))
  const jumpCandidates = connections.filter((item) => item.id !== bookmark?.id && !item.jumpBookmarkId)
  return <Modal title={bookmark ? t('common.editConnection') : t('common.newConnection')} onClose={onClose}><form className="form-grid" onSubmit={async (event) => { event.preventDefault(); try { await window.api.bookmarks.save({ ...form, id: bookmark?.id }); onSaved() } catch (error) { onError(errorMessage(error)) } }}>
    <div className="form-row"><label>{t('app.name')}<input required value={form.name} onChange={(event) => set('name', event.target.value)} placeholder={t('app.productionServer')} /></label><label>{t('app.group')}<select value={form.groupName} onChange={(event) => set('groupName', event.target.value)}><option value="">{t('common.ungrouped')}</option>{groups.filter(Boolean).map((group) => <option key={group} value={group}>{group}</option>)}</select></label></div>
    <label className="check-label"><input type="checkbox" checked={form.favorite} onChange={(event) => set('favorite', event.target.checked)} />{t('app.favoriteThisConnection')}</label>
    <div className="form-row"><label>{t('app.hostIpOrDomain')}<input required value={form.host} onChange={(event) => set('host', event.target.value)} placeholder="192.168.1.10" /></label><label className="port-field">{t('app.port')}<input type="number" min="1" max="65535" value={form.port} onChange={(event) => set('port', Number(event.target.value))} /></label></div>
    <label>{t('app.username')}<input required value={form.username} onChange={(event) => set('username', event.target.value)} placeholder="root" /></label>
    <label>{t('app.authentication')}<select value={form.authType} onChange={(event) => set('authType', event.target.value as BookmarkInput['authType'])}><option value="password">{t('app.password')}</option><option value="privateKey">{t('common.privateKey')}</option><option value="agent">SSH Agent</option></select></label>
    {form.authType === 'privateKey' && <label>{t('app.privateKeyFile')}<div className="input-button"><input readOnly value={form.privateKeyPath} placeholder={t('app.chooseAnOpensshPrivateKey')} /><button type="button" className="secondary-button" onClick={async () => { const path = await window.api.files.choosePrivateKey(); if (path) set('privateKeyPath', path) }}>{t('common.choose')}</button></div></label>}
    <label>{t('app.route')}<select value={form.jumpBookmarkId} onChange={(event) => set('jumpBookmarkId', event.target.value)}><option value="">{t('app.direct')}</option>{jumpCandidates.map((item) => <option key={item.id} value={item.id}>{t('app.viaValueValueValue', { value0: item.name, value1: item.username, value2: item.host })}</option>)}</select></label>
    <label className="check-label"><input type="checkbox" checked={form.keepaliveEnabled} onChange={(event) => set('keepaliveEnabled', event.target.checked)} />{t('app.keepTheSshSessionAlive')}</label>
    {form.keepaliveEnabled && <div className="form-row"><label>{t('app.keepaliveIntervalSeconds')}<input type="number" min="5" max="300" value={form.keepaliveIntervalSeconds} onChange={(event) => set('keepaliveIntervalSeconds', Number(event.target.value))} /></label><label>{t('app.maximumMissedResponses')}<input type="number" min="1" max="10" value={form.keepaliveCountMax} onChange={(event) => set('keepaliveCountMax', Number(event.target.value))} /></label></div>}
    <label>{t('app.notes')}<textarea rows={3} value={form.note} onChange={(event) => set('note', event.target.value)} placeholder={t('common.optional')} /></label>
    {bookmark?.hasSavedCredential && <button type="button" className="text-button danger" onClick={async () => { await window.api.bookmarks.forgetCredential(bookmark.id); onSaved() }}>{t('app.clearSavedCredentials')}</button>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button className="primary-button" type="submit">{t('common.save')}</button></div>
  </form></Modal>
}

function AuthDialog({ bookmark, jumpBookmark, onClose, onConnect }: { bookmark: Bookmark; jumpBookmark?: Bookmark; onClose(): void; onConnect(credentials: ConnectionCredentials): void }): React.JSX.Element {
  const { t } = useI18n()
  const [secret, setSecret] = useState(''); const [remember, setRemember] = useState(false); const [visible, setVisible] = useState(false)
  const [jumpSecret, setJumpSecret] = useState(''); const [rememberJump, setRememberJump] = useState(false); const [jumpVisible, setJumpVisible] = useState(false)
  const required = bookmark.authType === 'password' && !bookmark.hasSavedCredential
  const jumpRequired = Boolean(jumpBookmark?.authType === 'password' && !jumpBookmark.hasSavedCredential)
  return <Modal title={t('app.connectToValue', { value0: bookmark.name })} onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); if ((required && !secret) || (jumpRequired && !jumpSecret)) return; onConnect({ credential: secret || undefined, rememberCredential: remember, jumpCredential: jumpSecret || undefined, rememberJumpCredential: rememberJump }) }}>
    {jumpBookmark ? <div className="connection-route"><span><small>{t('common.jumpHost')}</small><strong>{jumpBookmark.name}</strong></span><ArrowRight size={16} /><span><small>{t('common.target')}</small><strong>{bookmark.name}</strong></span></div> : <div className="connection-target"><Server size={18} /><strong>{bookmark.username}@{bookmark.host}:{bookmark.port}</strong></div>}
    {jumpBookmark && jumpBookmark.authType !== 'agent' && <CredentialField bookmark={jumpBookmark} role={t('common.jumpHost')} secret={jumpSecret} setSecret={setJumpSecret} remember={rememberJump} setRemember={setRememberJump} visible={jumpVisible} setVisible={setJumpVisible} autoFocus />}
    {bookmark.authType !== 'agent' && <CredentialField bookmark={bookmark} role={jumpBookmark ? t('common.target') : ''} secret={secret} setSecret={setSecret} remember={remember} setRemember={setRemember} visible={visible} setVisible={setVisible} autoFocus={!jumpBookmark || jumpBookmark.authType === 'agent'} />}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button><button type="submit" className="primary-button">{t('common.connect')}</button></div>
  </form></Modal>
}

function CredentialField({ bookmark, role, secret, setSecret, remember, setRemember, visible, setVisible, autoFocus }: { bookmark: Bookmark; role: string; secret: string; setSecret(value: string): void; remember: boolean; setRemember(value: boolean): void; visible: boolean; setVisible(value: boolean): void; autoFocus: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const credentialName = bookmark.authType === 'password' ? t('app.password2') : t('app.privateKeyPassphraseOptional')
  const roleName = role || t('app.connection')
  return <div className="credential-block"><div className="credential-heading"><strong>{t('app.valueCredentials', { value0: roleName })}</strong><span>{bookmark.username}@{bookmark.host}:{bookmark.port}</span></div>
    <label>{role}{credentialName}<div className="password-input"><input autoFocus={autoFocus} type={visible ? 'text' : 'password'} required={bookmark.authType === 'password' && !bookmark.hasSavedCredential} value={secret} placeholder={bookmark.hasSavedCredential ? t('app.savedLeaveBlankToKeepUsingIt') : undefined} onChange={(event) => setSecret(event.target.value)} /><button className="icon-button" type="button" title={visible ? t('app.hidePassword') : t('app.showPassword')} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
    <label className="check-label"><input type="checkbox" checked={remember} disabled={!secret} onChange={(event) => setRemember(event.target.checked)} />{t('app.rememberCredentials', { role: role || t('common.connection') })}</label>
  </div>
}

function HostKeyDialog({ prompt, onDecision }: { prompt: HostKeyPrompt; onDecision(accept: boolean): void }): React.JSX.Element {
  const { t } = useI18n()
  const changed = prompt.status === 'changed'
  return <Modal title={changed ? t('app.hostKeyChanged') : t('app.verifyHostKey')} onClose={() => onDecision(false)}><div className="dialog-copy">
    <p>{changed ? t('app.theHostKeyDoesNotMatchThePreviously') : t('app.thisIsTheFirstConnectionToThisServer')}</p>
    <dl><dt>{t('app.server')}</dt><dd>{prompt.host}:{prompt.port}</dd>{prompt.previousFingerprint && <><dt>{t('app.previousFingerprint')}</dt><dd>{prompt.previousFingerprint}</dd></>}<dt>{t('app.currentFingerprint')}</dt><dd>{prompt.fingerprint}</dd></dl>
    <div className="dialog-actions"><button className="secondary-button" onClick={() => onDecision(false)}>{t('app.cancel')}</button><button className={changed ? 'danger-button' : 'primary-button'} onClick={() => onDecision(true)}>{t('app.trustAndContinue')}</button></div>
  </div></Modal>
}

function ConflictDialog({ conflict, onDecision }: { conflict: { sourcePath: string; destinationPath: string }; onDecision(value: ConflictResolution, apply: boolean): void }): React.JSX.Element {
  const { t } = useI18n()
  const [apply, setApply] = useState(false)
  return <Modal title={t('app.aFileWithThisNameAlreadyExists')} onClose={() => onDecision('skip', false)}><div className="dialog-copy"><p className="path-line">{conflict.destinationPath}</p><label className="check-label"><input type="checkbox" checked={apply} onChange={(event) => setApply(event.target.checked)} />{t('app.applyToAllConflictsInThisBatch')}</label><div className="dialog-actions spread"><button className="secondary-button" onClick={() => onDecision('skip', apply)}>{t('app.skip')}</button><button className="secondary-button" onClick={() => onDecision('rename', apply)}>{t('app.rename')}</button><button className="danger-button" onClick={() => onDecision('overwrite', apply)}>{t('app.overwrite')}</button></div></div></Modal>
}

function Modal({ title, onClose, children, wide = false, raised = false, className = '', suppressContextMenu = false }: { title: string; onClose(): void; children: React.ReactNode; wide?: boolean; raised?: boolean; className?: string; suppressContextMenu?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  return <div className={`modal-backdrop ${raised ? 'raised' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" onContextMenu={suppressContextMenu ? (event) => event.preventDefault() : undefined}><header><strong>{title}</strong><button className="icon-button" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></header>{children}</section></div>
}

function ConfirmationDialog({ confirmation, onDecision }: { confirmation: ConfirmationOptions; onDecision(accepted: boolean): void }): React.JSX.Element {
  const { t } = useI18n()
  return <Modal title={confirmation.title} onClose={() => onDecision(false)} raised className="secondary-confirm-dialog"><div className={`confirmation-dialog ${confirmation.kind}`}>
    <div className="confirmation-heading">{confirmation.kind === 'danger' ? <Trash2 size={22} /> : <ShieldAlert size={22} />}<div><strong>{confirmation.message}</strong>{confirmation.detail && <span>{confirmation.detail}</span>}</div></div>
    <div className="dialog-actions"><button type="button" autoFocus className="secondary-button" onClick={() => onDecision(false)}>{t('common.cancel')}</button><button type="button" className={confirmation.kind === 'danger' ? 'danger-button' : 'primary-button'} onClick={() => onDecision(true)}>{confirmation.kind === 'danger' ? <Trash2 size={15} /> : <Rocket size={15} />}{confirmation.confirmLabel}</button></div>
  </div></Modal>
}

function TransferPanel({ transfers, view, setView, onRetry, onCancel, onClear }: { transfers: TransferTask[]; view: 'queue' | 'history'; setView(value: 'queue' | 'history'): void; onRetry(task: TransferTask): void; onCancel(task: TransferTask): void; onClear(): void }): React.JSX.Element {
  const { t } = useI18n()
  const activeStatuses = ['queued', 'scanning', 'running', 'conflict']
  const shown = transfers.filter((item) => view === 'queue' ? activeStatuses.includes(item.status) || item.status === 'failed' : !activeStatuses.includes(item.status))
  const active = transfers.filter((item) => activeStatuses.includes(item.status))
  const totalBytes = active.reduce((sum, item) => sum + item.bytesTotal, 0)
  const transferredBytes = active.reduce((sum, item) => sum + item.bytesTransferred, 0)
  const speed = active.reduce((sum, item) => sum + item.speed, 0)
  const eta = speed > 0 && totalBytes > transferredBytes ? Math.ceil((totalBytes - transferredBytes) / speed) : 0
  const speedText = speed >= 1024 * 1024 ? `${(speed / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(speed / 1024)} KB/s`
  return <section className="transfer-panel"><header><div className="transfer-tabs"><button className={view === 'queue' ? 'active' : ''} onClick={() => setView('queue')}>{t('app.queue')} <span>{active.length}</span></button><button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>{t('app.history')}</button></div>{active.length > 0 && <div className="transfer-summary"><strong>{totalBytes ? Math.round(transferredBytes / totalBytes * 100) : 0}%</strong><span>{speedText}</span>{eta > 0 && <span>{eta >= 60 ? t('app.transferEtaMinutes', { value: Math.ceil(eta / 60) }) : t('app.transferEtaSeconds', { value: eta })}</span>}</div>}<button className="text-button" disabled={!transfers.some((item) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status))} onClick={onClear}>{t('app.clearTransferHistory')}</button></header>
    <div className="transfer-list">{shown.length === 0 ? <div className="transfer-empty">{view === 'queue' ? t('app.noActiveTransfers') : t('app.noTransferHistory')}</div> : shown.slice(0, 40).map((task) => {
      const percent = task.bytesTotal ? Math.min(100, Math.round(task.bytesTransferred / task.bytesTotal * 100)) : 0
      return <div className="transfer-row" key={task.id}><span className={`transfer-direction ${task.direction}`}>{task.direction === 'upload' ? '↑' : '↓'}</span><div className="transfer-info"><strong>{task.displayName}</strong><small>{task.error ?? `${task.sourcePath} → ${task.destinationPath}`}</small>{['running', 'scanning'].includes(task.status) && <div className="progress"><span style={{ width: `${percent}%` }} /></div>}</div><span className={`transfer-status ${task.status}`}>{task.status === 'running' ? `${percent}%` : ({ queued: t('app.queued'), scanning: t('app.scanning'), conflict: t('app.waiting'), completed: t('app.completed'), failed: t('app.failed'), cancelled: t('app.cancelled'), interrupted: t('app.interrupted') } as Record<string, string>)[task.status]}</span><div className="transfer-actions">{activeStatuses.includes(task.status) && <button className="icon-button" title={t('common.cancel')} onClick={() => onCancel(task)}><X size={15} /></button>}{['failed', 'cancelled', 'interrupted'].includes(task.status) && <button className="text-button" onClick={() => onRetry(task)}>{t('app.retry')}</button>}</div></div>
    })}</div>
  </section>
}
