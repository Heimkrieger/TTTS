// Точка входа main-процесса: папка данных, логи, настройки, окно, IPC.
import { hostname, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { FEEDBACK_URL, SUPPORT_URL, UPDATE_PUBLIC_KEY, UPDATE_REPO } from '@shared/brand'
import { Updater } from './update/updater'
import { launchApply, readInstallResult, unpackUpdate, type InstallPlan } from './update/install'
import type { FeedbackDraft } from '@shared/types'
import { FeedbackSender, buildReport, httpPostJson } from './feedback'
import { captionText } from './filters/pipeline'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  safeStorage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebFrameMain
} from 'electron'
import log from 'electron-log/main'
import { IPC, type AppInfo } from '@shared/ipc'
import type { Result } from '@shared/types'
import { canWriteDir, resolveDataDir } from './paths'
import { SettingsStore, type Encryptor } from './settings'
import { ChatService } from './chat/service'
import { httpFetchJson } from './chat/emotes'
import { fakeMessage } from './chat/fake'
import type { SocketLike } from './chat/twitch'
import { Journal } from './journal'
import { TtsQueue } from './queue/queue'
import { SilentPlayer, estimateProvider } from './queue/silent'
import { existsSync, readFileSync } from 'node:fs'
import { FishClient } from './tts/fish'
import { AudioCache } from './tts/cache'
import { FishProvider } from './tts/provider'
import { DailyBudget } from './tts/budget'
import { FishService } from './tts/service'
import { RendererPlayer } from './tts/rendererPlayer'
import { HOTKEY_LABEL, Hotkeys } from './hotkeys'
import { OverlayServer } from './overlay/server'
import { ObsPlayer } from './overlay/obsPlayer'

/** Только для разработки: ключ Fish из .env в корне проекта (для ручных проверок). */
function devEnvFishKey(): string | null {
  if (app.isPackaged) return null
  const file = join(app.getAppPath(), '.env')
  if (!existsSync(file)) return null
  const m = /^FISH_API_KEY=(\S+)/m.exec(readFileSync(file, 'utf8'))
  return m?.[1] ?? null
}

// 1. Папка данных выбирается ДО готовности приложения: Chromium тоже кладёт туда свой кэш,
//    поэтому в портативном режиме ничего не пишется в %APPDATA%.
/**
 * Тихий тестовый запуск (только разработка, TTS_TEST_INSTANCE=1): своя папка .devdata-test,
 * окно не показывается и не мешает, звук выключен, горячие клавиши не занимаются, страница
 * для OBS на порту +100. Так e2e-тесты идут рядом с основной копией программы, не трогая её.
 */
const TEST_INSTANCE = !app.isPackaged && process.env.TTS_TEST_INSTANCE === '1'
const overlayPort = (p: number): number => (TEST_INSTANCE ? p + 100 : p)

const dataDir = TEST_INSTANCE
  ? { dir: join(app.getAppPath(), '.devdata-test'), mode: 'dev' as const, notice: null }
  : resolveDataDir({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      exePath: process.execPath,
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      appDataDir: app.getPath('appData'),
      appName: app.getName(),
      canWrite: canWriteDir
    })
app.setPath('userData', dataDir.dir)
app.setPath('sessionData', join(dataDir.dir, 'chromium'))

// 2. Логи в файл в папке данных.
const logFile = join(dataDir.dir, 'logs', 'main.log')
log.transports.file.resolvePathFn = () => logFile
log.transports.file.maxSize = 5 * 1024 * 1024
log.info(`start v${app.getVersion()}, data=${dataDir.dir} (${dataDir.mode})`)
if (dataDir.notice) log.warn(dataDir.notice)

process.on('uncaughtException', (e) => log.error('uncaughtException', e))
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e))

// Только для разработки: порт отладки для e2e-тестов.
if (!app.isPackaged && process.env.TTS_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TTS_DEBUG_PORT)
}

// 3. Одна копия программы: две копии писали бы в одни настройки.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const safeStorageEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#121214',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Проверка орфографии подчёркивает теги и ники красным - в программе для стрима она мешает.
      spellcheck: false,
      // Тестовый запуск работает скрытым: страница не должна засыпать в фоне.
      backgroundThrottling: !TEST_INSTANCE
    },
    skipTaskbar: TEST_INSTANCE,
    // Тестовый запуск: окно за пределами экрана и без фокуса. Оно рисуется (нужно для
    // скриншотов в e2e-тестах), но не видно и не перехватывает клавиатуру.
    ...(TEST_INSTANCE ? { x: -4000, y: -4000, focusable: false } : {})
  })
  if (TEST_INSTANCE) {
    win.webContents.setAudioMuted(true)
    win.on('ready-to-show', () => win.showInactive())
  } else win.on('ready-to-show', () => win.show())
  // Ссылки открываем в обычном браузере и только на известные сайты; новые окна не создаём.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedLink(url)) void shell.openExternal(url)
    else log.warn('ссылка не открыта: сайт не в списке разрешённых')
    return { action: 'deny' }
  })
  // Окно нельзя увести на другую страницу (перетащили ссылку или файл, переход по ссылке):
  // чужая страница получила бы доступ к командам программы.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-redirect', (e) => e.preventDefault())
  win.webContents.on('render-process-gone', (_e, details) =>
    log.error('renderer упал', details.reason, details.exitCode)
  )
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') log.error('renderer console:', event.message)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Сайты, которые программа открывает в браузере (справка Fish, Twitch, поддержка автора). */
const LINK_HOSTS = ['fish.audio', 'docs.fish.audio', 'twitch.tv', 'www.twitch.tv', 'dev.twitch.tv']
function isAllowedLink(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const support = SUPPORT_URL ? new URL(SUPPORT_URL).host : ''
    return LINK_HOSTS.includes(u.host) || (support !== '' && u.host === support)
  } catch {
    return false
  }
}

/** Команды принимаем только от собственной страницы программы (защита, если окно всё же увели). */
function isOwnPage(frame: WebFrameMain | null): boolean {
  const url = frame?.url ?? ''
  const dev = process.env.ELECTRON_RENDERER_URL
  return url.startsWith('file://') || (!app.isPackaged && !!dev && url.startsWith(dev))
}
function handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isOwnPage(e.senderFrame)) {
      log.warn(`команда ${channel} отклонена: пришла не от окна программы`)
      throw new Error('forbidden')
    }
    return fn(e, ...args)
  })
}
function on(channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    if (isOwnPage(e.senderFrame)) fn(e, ...args)
  })
}

/** Отправить событие в окно, если оно открыто. */
function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

interface Services {
  store: SettingsStore
  chat: ChatService
  queue: TtsQueue
  journal: Journal
  fish: FishService
  player: RendererPlayer
  /** Переключить очередь между Fish и беззвучным режимом (есть ли ключ). */
  updateBackend: () => void
  hotkeys: Hotkeys
  overlay: OverlayServer
  obsPlayer: ObsPlayer
}

function registerIpc({
  store,
  chat,
  queue,
  journal,
  fish,
  player,
  updateBackend,
  hotkeys,
  overlay,
  obsPlayer
}: Services): void {
  const applyHotkeys = (): void => {
    if (TEST_INSTANCE) return // тестовый запуск не занимает горячие клавиши основной копии
    if (hotkeys.apply(store.current().hotkeys)) {
      for (const h of hotkeys.status) {
        if (!h.ok)
          journal.add(
            'warn',
            `Горячая клавиша "${HOTKEY_LABEL[h.action]}" (${h.accelerator}): ${h.error}`
          )
      }
      send(IPC.evHotkeys, hotkeys.status)
    }
  }
  applyHotkeys()
  const broadcast = (): void => {
    send(IPC.settingsChanged, store.getPublic())
    chat.applySettings()
    player.setVolume(store.current().tts.volume)
    obsPlayer.setVolume(store.current().tts.volume)
    fish.emitStatus() // модель или лимит могли измениться: строка бюджета в меню
    applyHotkeys()
    // Вывод звука и страница для OBS: режим, порт, показ текста.
    const a = store.current().audio
    void overlay.start(overlayPort(a.obsPort))
    overlay.setShowText(a.overlayText)
    updateBackend()
  }
  const keyChanged = (): void => {
    updateBackend()
    void fish.refreshBalance()
  }

  handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    dataDir: dataDir.dir,
    dataMode: dataDir.mode,
    dataNotice: dataDir.notice,
    settingsNotice: store.loadNotice,
    logFile
  }))
  handle(IPC.appOpenDataDir, async () => {
    const err = await shell.openPath(dataDir.dir)
    if (err) log.error('не открылась папка данных', err)
  })

  handle(IPC.settingsGet, () => store.getPublic())
  handle(IPC.settingsSet, (_e, patch: unknown) => {
    const res = store.update(patch)
    if (res.ok) broadcast()
    else log.warn('settings:set отклонено:', res.error)
    return res
  })
  handle(IPC.secretsSetFishKey, (_e, key: unknown) => {
    const res = store.setFishKey(key)
    // Сам ключ не логируем никогда, только факт.
    if (res.ok) {
      log.info('ключ Fish сохранён')
      broadcast()
      keyChanged()
    } else log.warn('ключ Fish не сохранён:', res.error)
    return res
  })
  handle(IPC.secretsClearFishKey, () => {
    const res = store.clearFishKey()
    log.info('ключ Fish удалён')
    broadcast()
    keyChanged()
    return res
  })

  handle(IPC.chatStatus, () => chat.chat.status)
  handle(IPC.chatFeed, () => chat.feed.snapshot())
  handle(IPC.chatEmotes, () => chat.emotes.status)
  handle(IPC.chatTest, (_e, text: unknown) =>
    chat.testMessage(typeof text === 'string' ? text.slice(0, 2000) : '')
  )
  chat.on('status', (s) => send(IPC.evChatStatus, s))
  chat.on('feed', (entries) => send(IPC.evChatFeed, entries))
  chat.on('feedReset', () => send(IPC.evChatFeedReset))
  chat.on('emotes', (s) => send(IPC.evChatEmotes, s))

  const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 200) : '')

  // Очередь озвучки и управление.
  const id = (v: unknown): string => str(v)
  handle(IPC.queueSnapshot, () => queue.snapshot())
  handle(IPC.queuePause, () => queue.pause())
  handle(IPC.queueResume, () => queue.resume())
  handle(IPC.queueSkip, () => {
    const cur = queue.snapshot().current
    if (cur) journal.add('info', `Пропущено: ${cur.message.displayName}`)
    queue.skipCurrent()
  })
  handle(IPC.queueRemove, (_e, itemId: unknown) => {
    const it = queue.snapshot().items.find((x) => x.id === id(itemId))
    const ok = queue.remove(id(itemId))
    if (ok && it) journal.add('info', `Убрано из очереди: ${it.message.displayName}`)
    return ok
  })
  handle(IPC.queueMoveToTop, (_e, itemId: unknown) => queue.moveToTop(id(itemId)))
  handle(IPC.queueClear, () => {
    const n = queue.clear()
    if (n) journal.add('info', `Очередь очищена (${n})`)
  })
  handle(IPC.queueReplay, () => {
    if (!queue.replayLast()) journal.add('warn', 'Повторять нечего: ещё ничего не прозвучало')
  })
  handle(IPC.queueReplayItem, (_e, itemId: unknown): Result<null> => {
    if (queue.replay(id(itemId))) return { ok: true, value: null }
    return { ok: false, error: 'Этого сообщения уже нет в истории (хранятся последние 500)' }
  })
  handle(IPC.queueHistory, () => queue.fullHistory())
  queue.on('update', (s) => send(IPC.evQueue, s))

  // Страница для OBS.
  handle(IPC.overlayStatus, () => overlay.status())
  let lastClients = overlay.status().clients
  overlay.on('status', (s) => {
    send(IPC.evOverlay, s)
    if (s.clients !== lastClients) {
      journal.add(
        'info',
        s.clients > lastClients ? 'OBS: источник подключился' : 'OBS: источник отключился'
      )
      lastClients = s.clients
    }
  })
  queue.on('journal', (level, text) => journal.add(level, text))

  handle(IPC.journalGet, () => journal.snapshot())

  // Отзывы: отчёт собирается и очищается здесь, renderer получает его только для показа.
  const feedback = new FeedbackSender(FEEDBACK_URL, httpPostJson)
  const draftOf = (v: unknown): FeedbackDraft => {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
    return {
      kind: o.kind === 'idea' ? 'idea' : 'bug',
      // Обрезаем до очистки: огромная строка не должна подвесить регулярки.
      text: typeof o.text === 'string' ? o.text.slice(0, 5000) : '',
      contact: typeof o.contact === 'string' ? o.contact.slice(0, 200) : '',
      attachLog: o.attachLog === true
    }
  }
  const report = (v: unknown): ReturnType<typeof buildReport> =>
    buildReport(draftOf(v), {
      appVersion: app.getVersion(),
      os: `Windows ${process.getSystemVersion()}`,
      logFile,
      channels: [store.current().twitch.channel, ...chat.channelsSeen].filter(Boolean),
      viewers: [
        ...chat.feed.snapshot().map((e) => e.message.user),
        ...store.current().mutes.map((m) => m.login),
        ...store.current().filters.blacklist
      ],
      literals: [
        dataDir.dir,
        dirname(process.execPath),
        app.getPath('home'),
        hostname(),
        userInfo().username
      ]
    })
  handle(IPC.feedbackPreview, (_e, d: unknown) => report(d))
  handle(IPC.feedbackConfigured, () => feedback.configured)
  handle(IPC.feedbackSend, async (_e, d: unknown) => {
    const r = await feedback.send(report(d))
    if (r.ok) log.info('Отзыв отправлен')
    else log.warn(`Отзыв не отправлен: ${r.error}`)
    return r
  })
  journal.on('entry', (e) => send(IPC.evJournal, e))

  // Действия над зрителями.
  const after = <T>(r: T): T => {
    send(IPC.settingsChanged, store.getPublic())
    return r
  }
  handle(IPC.actSpeak, (_e, messageId: unknown) => chat.speakManually(id(messageId)))
  handle(IPC.actMute, (_e, login: unknown, minutes: unknown) =>
    after(chat.mute(str(login), typeof minutes === 'number' ? minutes : NaN))
  )
  handle(IPC.actUnmute, (_e, login: unknown) => after(chat.unmute(str(login))))
  handle(IPC.actBlacklist, (_e, login: unknown, on: unknown) =>
    after(chat.blacklist(str(login), on === true))
  )

  // Fish Audio: ключ и баланс, голоса, тест.
  handle(IPC.fishStatus, () => fish.status())
  handle(IPC.fishRefresh, async () => {
    await fish.refreshBalance()
    return fish.status()
  })
  handle(IPC.fishSearch, (_e, q: unknown, lang: unknown) =>
    fish.searchVoices(str(q), typeof lang === 'string' && lang ? lang : null)
  )
  handle(IPC.fishAddVoice, async (_e, input: unknown) => after(await fish.addVoice(str(input))))
  handle(IPC.fishSaveVoice, (_e, vid: unknown, title: unknown) => {
    fish.saveFavorite(str(vid), str(title) || str(vid))
    send(IPC.settingsChanged, store.getPublic())
  })
  handle(IPC.fishRemoveVoice, (_e, vid: unknown) => {
    fish.removeFavorite(str(vid))
    send(IPC.settingsChanged, store.getPublic())
  })
  handle(IPC.fishTest, (_e, text: unknown, voiceId: unknown) =>
    fish.test(
      typeof text === 'string' ? text.slice(0, 500) : '',
      typeof voiceId === 'string' && /^[0-9a-f]{32}$/.test(voiceId) ? voiceId : undefined
    )
  )
  handle(IPC.fishCheck, async () => {
    const r = await fish.checkConnection()
    journal.add(r.ok ? 'info' : 'warn', `Проверка связи с Fish: ${r.verdict}`)
    return r
  })
  fish.on('status', (s) => send(IPC.evFish, s))

  handle(IPC.hotkeysStatus, () => hotkeys.status)
  // Проблема со звуком в окне (устройство пропало и т.п.).
  on(IPC.playerProblem, (_e, text: unknown) => {
    if (typeof text === 'string') journal.add('warn', `Звук: ${text.slice(0, 300)}`)
  })

  // Сигнал из окна: сообщение доиграло или остановлено.
  on(IPC.playerEnded, (_e, pid: unknown, result: unknown, error: unknown) => {
    if (typeof error === 'string')
      journal.add(
        'error',
        `Сообщение не проигралось. Проверьте устройство в разделе "Звук". Подробности для отчёта: ${error.slice(0, 300)}`
      )
    if (typeof pid === 'number') player.finish(pid, result === 'stopped' ? 'stopped' : 'ended')
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(() => {
  // Список устройств вывода с именами (для выбора VB-Cable и т.п.): разрешаем окну программы
  // смотреть устройства и выбирать выход звука. Камера и микрофон при этом не включаются.
  // Плюс запись в буфер обмена (кнопка "Скопировать" у шпаргалки в справке).
  const allowed = ['media', 'speaker-selection', 'clipboard-sanitized-write']
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowed.includes(permission)
  )
  // Запрос доступа: микрофон и камеру не даём никогда (программе они не нужны, список устройств
  // и выбор выхода работают через проверку выше).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission !== 'media' && allowed.includes(permission))
  )
  // Проверка орфографии выключена и для всей сессии: Chromium не скачивает словари из интернета.
  session.defaultSession.setSpellCheckerEnabled(false)
  const store = new SettingsStore(join(dataDir.dir, 'settings.json'), safeStorageEncryptor, log)
  const journal = new Journal(log)
  // Без ключа Fish - беззвучный режим с примерной длительностью.
  const queue = new TtsQueue(estimateProvider, new SilentPlayer(), () => store.current().tts, true)
  const envKey = devEnvFishKey()
  if (envKey) log.info('ключ Fish взят из .env (режим разработки)')
  let fishRef: FishService | null = null
  const client = new FishClient(() => fishRef?.getKey() ?? null)
  const provider = new FishProvider(
    client,
    new AudioCache(join(dataDir.dir, 'cache')),
    () => store.current(),
    new DailyBudget(join(dataDir.dir, 'budget.json'), Date.now, (t) => journal.add('warn', t))
  )
  const fish = new FishService(store, client, provider, journal, envKey)
  fishRef = fish
  const player = new RendererPlayer(
    {
      send: (channel, payload) => {
        if (!mainWindow || mainWindow.isDestroyed()) return false
        mainWindow.webContents.send('player:' + channel, payload)
        return true
      }
    },
    (text) => journal.add('warn', text)
  )
  const silentPlayer = new SilentPlayer()
  // Локальная страница для OBS: подпись "кто говорит" всегда, звук - в режиме вывода "obs".
  const overlay = new OverlayServer(log)
  const obsPlayer = new ObsPlayer(overlay, (text) => journal.add('warn', text))
  void overlay.start(overlayPort(store.current().audio.obsPort))
  overlay.setShowText(store.current().audio.overlayText)
  queue.on('update', (snap) =>
    overlay.caption(
      snap.current
        ? {
            nick: snap.current.message.displayName,
            text: captionText(snap.current.text, snap.current.message.displayName, store.current())
          }
        : null
    )
  )
  let lastBackend = ''
  const updateBackend = (): void => {
    const out = store.current().audio.output
    const key = fish.getKey() ? out : 'silent'
    if (key === lastBackend) return
    lastBackend = key
    if (key === 'silent') queue.setBackend(estimateProvider, silentPlayer, true)
    else queue.setBackend(provider, out === 'obs' ? obsPlayer : player, false)
    log.info(`звук: ${key === 'silent' ? 'без звука (нет ключа Fish)' : out}`)
  }
  updateBackend()
  // Ошибки ключа и денег из очереди показываем и в строке Fish внизу.
  queue.on('journal', (level, text) => {
    if (level === 'error' && text.startsWith('Озвучка на паузе')) fish.setError(text)
  })
  // WebSocket встроен в Node 24 (main-процесс Electron 45).
  const chat = new ChatService(
    store,
    (url) => new WebSocket(url) as unknown as SocketLike,
    httpFetchJson,
    queue,
    journal,
    log
  )
  // Проверка нагрузки: TTS_FAKE_CHAT=10 - фейковые сообщения в секунду (только разработка).
  const fakeRate = Number(process.env.TTS_FAKE_CHAT)
  if (!app.isPackaged && fakeRate > 0) {
    setInterval(() => chat.injectMessage(fakeMessage(Date.now())), 1000 / Math.min(fakeRate, 100))
    log.warn(`Фейковый чат: ${fakeRate} сообщений в секунду (TTS_FAKE_CHAT)`)
  }
  // Горячие клавиши: пропуск, пауза, вкл/выкл озвучки.
  const hotkeys = new Hotkeys(globalShortcut, {
    skip: () => {
      const cur = queue.snapshot().current
      if (cur) journal.add('info', `Пропущено (горячая клавиша): ${cur.message.displayName}`)
      queue.skipCurrent()
    },
    pause: () => (queue.snapshot().paused ? queue.resume() : queue.pause()),
    toggle: () => {
      const on = !store.current().tts.enabled
      store.update({ tts: { enabled: on } })
      journal.add(
        'info',
        on ? 'Озвучка включена (горячая клавиша)' : 'Озвучка выключена (горячая клавиша)'
      )
      send(IPC.settingsChanged, store.getPublic())
    }
  })
  registerIpc({
    store,
    chat,
    queue,
    journal,
    fish,
    player,
    updateBackend,
    hotkeys,
    overlay,
    obsPlayer
  })
  fish.start()

  // Обновления: только в собранной программе, которая лежит в своей папке (портативный режим).
  const updateDir = join(dataDir.dir, 'update')
  const updater = new Updater(
    {
      repo: UPDATE_REPO,
      publicKeyPem: UPDATE_PUBLIC_KEY,
      currentVersion: app.getVersion(),
      workDir: updateDir
    },
    (s) => {
      send(IPC.evUpdate, s)
      if (s.state === 'error') journal.add('warn', `Обновление: ${s.error}`)
      if (s.state === 'available' && !s.startup)
        journal.add(
          'info',
          `Вышла версия ${s.version}: окно обновления появится при следующем запуске`
        )
    }
  )
  if (!app.isPackaged) updater.disable('в режиме разработки обновления выключены')
  else if (dataDir.mode !== 'portable')
    updater.disable(
      'папка программы недоступна для записи: распакуйте программу в обычную папку, тогда обновления заработают'
    )
  const installed = readInstallResult(updateDir)
  if (installed) journal.add(installed.ok ? 'info' : 'error', installed.text)
  void updater.check(true)
  // Дальше раз в 6 часов: новая версия посреди стрима ничего не прерывает.
  setInterval(() => void updater.check(false), 6 * 60 * 60_000)

  handle(IPC.updateStatus, () => updater.status)
  handle(IPC.updateCheck, () => updater.check(false))
  handle(IPC.updateQuit, () => app.quit())
  handle(IPC.updateInstall, async () => {
    const s = await updater.download()
    const zip = updater.readyZip
    if (s.state !== 'ready' || !zip) return s
    const plan: InstallPlan = {
      zip,
      workDir: updateDir,
      appDir: dirname(process.execPath),
      exe: process.execPath,
      appPid: process.pid,
      version: s.version
    }
    try {
      updater.installing(0)
      await unpackUpdate(plan, (p) => updater.installing(p))
      await launchApply(plan)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`обновление ${s.version}: ${msg}`)
      journal.add('error', `Обновление ${s.version} не установилось: ${msg}`)
      updater.installFailed(msg)
      return updater.status
    }
    log.info(`обновление ${s.version}: распаковано, установка после закрытия`)
    setTimeout(() => app.quit(), 300)
    return s
  })

  mainWindow = createWindow()
  mainWindow.on('closed', () => (mainWindow = null))
  chat.applySettings()
  app.on('before-quit', () => {
    queue.stop()
    hotkeys.stop()
    void overlay.stop()
    fish.stop()
    chat.stop()
  })
})

app.on('window-all-closed', () => app.quit())
