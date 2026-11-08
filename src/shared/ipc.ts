// Контракт между renderer и main: что renderer может вызвать через window.api.
import type { PublicSettings, SettingsPatch } from './settings'
import type {
  ChatStatus,
  EmoteProviderStatus,
  FeedEntry,
  ConnectionCheck,
  FishStatus,
  HotkeyStatus,
  JournalEntry,
  OverlayStatus,
  VoiceInfo,
  FeedbackDraft,
  UpdateStatus,
  FeedbackReport,
  QueueItemView,
  QueueSnapshot,
  Result
} from './types'

/** Результат проверки сообщения фильтрами (для окна "Проверка"). */
export type FilterTestResult =
  { pass: true; text: string } | { pass: false; kind: 'no-prefix' | 'rejected'; reason: string }

export type DataMode = 'portable' | 'dev' | 'fallback'

export interface AppInfo {
  version: string
  /** Папка данных: настройки, логи, кэш. */
  dataDir: string
  dataMode: DataMode
  /** Почему данные лежат не там, где ожидалось (только для fallback). */
  dataNotice: string | null
  /** Предупреждение о настройках при загрузке (файл повреждён и т.п.). */
  settingsNotice: string | null
  logFile: string
}

export interface TtsApi {
  app: {
    info(): Promise<AppInfo>
    openDataDir(): Promise<void>
  }
  settings: {
    get(): Promise<PublicSettings>
    set(patch: SettingsPatch): Promise<Result<PublicSettings>>
    /** Подписка на изменения настроек. Возвращает функцию отписки. */
    onChanged(cb: (s: PublicSettings) => void): () => void
  }
  secrets: {
    setFishKey(key: string): Promise<Result<PublicSettings>>
    clearFishKey(): Promise<PublicSettings>
  }
  chat: {
    status(): Promise<ChatStatus>
    feed(): Promise<FeedEntry[]>
    emotes(): Promise<EmoteProviderStatus[]>
    /** Прогнать текст через фильтры, как будто его написал стример. */
    testMessage(text: string): Promise<FilterTestResult>
    onStatus(cb: (s: ChatStatus) => void): () => void
    onFeed(cb: (entries: FeedEntry[]) => void): () => void
    onFeedReset(cb: () => void): () => void
    onEmotes(cb: (s: EmoteProviderStatus[]) => void): () => void
  }
  queue: {
    snapshot(): Promise<QueueSnapshot>
    pause(): Promise<void>
    resume(): Promise<void>
    /** Пропустить то, что звучит сейчас. */
    skip(): Promise<void>
    remove(itemId: string): Promise<boolean>
    moveToTop(itemId: string): Promise<boolean>
    clear(): Promise<void>
    replayLast(): Promise<void>
    /** Повторить сообщение из истории. Ошибка - если его уже нет в истории. */
    replay(itemId: string): Promise<Result<null>>
    /** Вся история озвученного (до 500), новые сверху. */
    history(): Promise<QueueItemView[]>
    onUpdate(cb: (s: QueueSnapshot) => void): () => void
  }
  update: {
    status(): Promise<UpdateStatus>
    /** Проверить сейчас (кнопка в разделе "Подключение"). */
    check(): Promise<UpdateStatus>
    /** Скачать, проверить подпись, закрыть программу, установить и запустить заново. */
    install(): Promise<UpdateStatus>
    /** Закрыть программу (кнопка "Выйти" в окне обновления). */
    quit(): Promise<void>
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
  feedback: {
    /** Отчёт, который уйдёт: пользователь видит его целиком до отправки. */
    preview(draft: FeedbackDraft): Promise<FeedbackReport>
    send(draft: FeedbackDraft): Promise<Result<null>>
    /** Задан ли адрес отправки (иначе только "Скопировать"). */
    configured(): Promise<boolean>
  }
  journal: {
    get(): Promise<JournalEntry[]>
    onEntry(cb: (e: JournalEntry) => void): () => void
  }
  fish: {
    status(): Promise<FishStatus>
    refresh(): Promise<FishStatus>
    searchVoices(query: string, language: string | null): Promise<Result<VoiceInfo[]>>
    /** Добавить в избранное по ссылке или id и выбрать. */
    addVoice(input: string): Promise<Result<VoiceInfo>>
    /** Добавить найденный голос в избранное и выбрать. */
    saveVoice(id: string, title: string): Promise<void>
    removeVoice(id: string): Promise<void>
    /** voiceId - послушать другой голос, не выбирая его. */
    test(
      text: string,
      voiceId?: string
    ): Promise<Result<{ audio: Uint8Array; durationSec: number }>>
    /** Проверка связи: сервер, ключ, синтез, с временем каждого шага. */
    checkConnection(): Promise<ConnectionCheck>
    onStatus(cb: (s: FishStatus) => void): () => void
  }
  /** Команды проигрывания из main и ответ "доиграло". */
  player: {
    onPlay(
      cb: (p: { id: number; audio: Uint8Array; volume: number; trimSec: number | null }) => void
    ): () => void
    onStop(cb: (p: { id: number; fadeMs: number }) => void): () => void
    onPause(cb: () => void): () => void
    onResume(cb: () => void): () => void
    onVolume(cb: (p: { volume: number }) => void): () => void
    /** Проблема со звуком (устройство пропало и т.п.) - в журнал. */
    problem(text: string): void
    /** error - звук не удалось проиграть (покажется в журнале). */
    ended(id: number, result: 'ended' | 'stopped', error?: string): void
  }
  overlay: {
    status(): Promise<OverlayStatus>
    onStatus(cb: (s: OverlayStatus) => void): () => void
  }
  hotkeys: {
    status(): Promise<HotkeyStatus[]>
    onStatus(cb: (s: HotkeyStatus[]) => void): () => void
  }
  /** Действия стримера над сообщениями и зрителями. */
  actions: {
    speak(messageId: string): Promise<Result<null>>
    mute(login: string, minutes: number): Promise<Result<null>>
    unmute(login: string): Promise<Result<null>>
    blacklist(login: string, on: boolean): Promise<Result<null>>
  }
}

/** Имена IPC-каналов в одном месте, чтобы main и preload не разошлись. */
export const IPC = {
  appInfo: 'app:info',
  appOpenDataDir: 'app:open-data-dir',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',
  secretsSetFishKey: 'secrets:set-fish-key',
  secretsClearFishKey: 'secrets:clear-fish-key',
  chatStatus: 'chat:status',
  chatFeed: 'chat:feed',
  chatEmotes: 'chat:emotes',
  chatTest: 'chat:test',
  evChatStatus: 'chat:on-status',
  evChatFeed: 'chat:on-feed',
  evChatFeedReset: 'chat:on-feed-reset',
  evChatEmotes: 'chat:on-emotes',
  queueSnapshot: 'queue:snapshot',
  queuePause: 'queue:pause',
  queueResume: 'queue:resume',
  queueSkip: 'queue:skip',
  queueRemove: 'queue:remove',
  queueMoveToTop: 'queue:move-to-top',
  queueClear: 'queue:clear',
  queueReplay: 'queue:replay',
  queueReplayItem: 'queue:replay-item',
  queueHistory: 'queue:history',
  evQueue: 'queue:on-update',
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateQuit: 'update:quit',
  evUpdate: 'update:on-status',
  feedbackPreview: 'feedback:preview',
  feedbackSend: 'feedback:send',
  feedbackConfigured: 'feedback:configured',
  journalGet: 'journal:get',
  evJournal: 'journal:on-entry',
  actSpeak: 'act:speak',
  actMute: 'act:mute',
  actUnmute: 'act:unmute',
  actBlacklist: 'act:blacklist',
  fishStatus: 'fish:status',
  fishRefresh: 'fish:refresh',
  fishSearch: 'fish:search',
  fishAddVoice: 'fish:add-voice',
  fishSaveVoice: 'fish:save-voice',
  fishRemoveVoice: 'fish:remove-voice',
  fishTest: 'fish:test',
  fishCheck: 'fish:check',
  evFish: 'fish:on-status',
  playerEnded: 'player:ended',
  playerProblem: 'player:problem',
  hotkeysStatus: 'hotkeys:status',
  overlayStatus: 'overlay:status',
  evOverlay: 'overlay:on-status',
  evHotkeys: 'hotkeys:on-status'
} as const
