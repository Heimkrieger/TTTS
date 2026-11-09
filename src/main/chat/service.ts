// Связка: чат Twitch -> фильтры -> очередь озвучки -> лента.
// Здесь же все действия стримера над зрителями: мьют на время, чёрный список, "озвучить вручную".
import { EventEmitter } from 'node:events'
import type { Settings } from '@shared/settings'
import type {
  ChatMessage,
  ChatStatus,
  EmoteProviderStatus,
  FeedEntry,
  FeedStatus,
  QueueItemView,
  Result
} from '@shared/types'
import {
  commitFiltered,
  createFilterState,
  type FilterOutcome,
  isTtsReward,
  matchPrefix,
  runFilters,
  stripReplyMention,
  twitchEmoteNames
} from '../filters/pipeline'
import type { Journal } from '../journal'
import type { TtsQueue } from '../queue/queue'
import type { SettingsStore } from '../settings'
import { ThirdPartyEmotes, type FetchJson } from './emotes'
import { ChatFeed } from './feed'
import { TwitchChat, type SocketFactory } from './twitch'

/** Приоритеты в очереди: вручную и награды встают перед обычным чатом. */
export const PRIORITY = { chat: 0, reward: 5, manual: 5 } as const

export interface ChatServiceEvents {
  status: [ChatStatus]
  emotes: [EmoteProviderStatus[]]
  /** Новые или изменённые записи ленты. */
  feed: [FeedEntry[]]
  /** Лента очищена (смена канала). */
  feedReset: []
}

const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** Статус в ленте по состоянию элемента очереди. */
function feedStatusOf(v: QueueItemView): FeedStatus {
  switch (v.status) {
    case 'queued':
    case 'synthesizing':
    case 'ready':
      return 'queued'
    case 'playing':
      return 'speaking'
    case 'done':
      return 'spoken'
    case 'skipped':
    case 'failed':
      return 'skipped'
  }
}

export class ChatService extends EventEmitter<ChatServiceEvents> {
  readonly chat: TwitchChat
  readonly emotes: ThirdPartyEmotes
  readonly feed = new ChatFeed()
  private filterState = createFilterState()
  /** Каналы этой сессии: чтобы скрыть их все в отчёте об ошибке. */
  readonly channelsSeen = new Set<string>()

  constructor(
    private readonly store: SettingsStore,
    socketFactory: SocketFactory,
    fetchJson: FetchJson,
    private readonly queue: TtsQueue,
    private readonly journal: Journal,
    log: { info(...a: unknown[]): void; warn(...a: unknown[]): void },
    private readonly now: () => number = Date.now
  ) {
    super()
    this.chat = new TwitchChat(socketFactory, log)
    this.emotes = new ThirdPartyEmotes(fetchJson, (s) => this.emit('emotes', s))

    this.chat.on('status', (s) => {
      if (s.state === 'error' || s.state === 'reconnecting') log.warn('chat:', s.state, s.detail)
      this.emit('status', s)
    })
    this.chat.on('room', (channel, roomId) => {
      // id канала в журнал не пишем: по нему канал находится однозначно.
      log.info(`chat: вошли в канал ${channel}`)
      this.channelsSeen.add(channel)
      void this.emotes.setRoom(roomId)
    })
    this.chat.on('message', (m) => this.onMessage(m))
    this.chat.on('deleted', (id) => {
      this.queue.removeByMessageId(id, 'удалено модератором')
      const e = this.feed.markDeleted(id)
      if (e) this.emit('feed', [{ ...e }])
    })
    this.chat.on('userCleared', (login, reason) => {
      const n = this.queue.removeByUser(login, `${reason} от модератора`, true)
      if (n) this.journal.add('info', `${login}: ${reason}, убрано из очереди: ${n}`)
      this.emitFeed(this.feed.markUserCleared(login, reason))
    })
    this.chat.on('chatCleared', () => {
      const n = this.queue.clearChat('чат очищен модератором')
      if (n) this.journal.add('info', `Модератор очистил чат, очередь очищена (${n})`)
      this.emitFeed(this.feed.markAllCleared())
    })
    // Очередь сообщает о каждом сообщении: показываем это в ленте.
    this.queue.on('item', (v) => {
      const e = this.feed.setStatus(v.message.id, feedStatusOf(v), v.reason)
      if (e) this.emit('feed', [{ ...e }])
    })
  }

  private get settings(): Readonly<Settings> {
    return this.store.current()
  }

  private emitFeed(entries: FeedEntry[]): void {
    if (entries.length)
      this.emit(
        'feed',
        entries.map((e) => ({ ...e }))
      )
  }

  /** Применить настройки (канал). Вызывается при старте и при каждом изменении. */
  applySettings(): void {
    const channel = this.settings.twitch.channel
    if (channel !== this.chat.status.channel) {
      // Сообщения старого канала из очереди тоже убираем: в ленте их уже не будет видно.
      const old = this.chat.status.channel
      const dropped = old ? this.queue.clear() : 0
      if (dropped)
        this.journal.add('info', `Канал сменился: очередь канала ${old} очищена (${dropped})`)
      this.feed.clear()
      this.filterState = createFilterState()
      this.emit('feedReset')
      void this.emotes.setRoom(null)
      this.chat.setChannel(channel)
    }
  }

  /** Сообщение не из Twitch: фейковый чат для проверки нагрузки (только в разработке). */
  injectMessage(m: ChatMessage): void {
    this.onMessage(m)
  }

  private onMessage(m: ChatMessage): void {
    const settings = this.settings
    const now = this.now()
    const r = this.filter(m, settings, now)
    let entry: FeedEntry
    if (r.pass) {
      entry = this.feed.add(m, 'queued', null, r.text)
      this.emit('feed', [{ ...entry }])
      const reward = isTtsReward(m, settings)
      const item = this.queue.enqueue(
        m,
        r.text,
        reward
          ? { priority: PRIORITY.chat, source: 'reward' }
          : { priority: PRIORITY.chat, source: 'chat' }
      )
      // Кулдаун и повторы засчитываются, только если сообщение правда встало в очередь
      // (очередь может сразу отбросить слишком длинное). Повторы - по тексту без шаблона ника.
      if (item.status !== 'skipped') {
        commitFiltered(m, r.dupText ?? r.text, this.filterState, now, settings)
      }
      return
    } else {
      entry = this.feed.add(m, r.kind === 'no-prefix' ? 'no-prefix' : 'rejected', r.reason, null)
    }
    this.emit('feed', [{ ...entry }])
  }

  private filter(m: ChatMessage, settings: Settings, now: number): FilterOutcome {
    return runFilters(m, settings, this.filterState, {
      now,
      queueLength: this.queue.length,
      isThirdPartyEmote: (w) => this.emotes.has(w)
    })
  }

  /**
   * Мягкие фильтры для действий стримера: без префикса, ролей, кулдауна, дублей, мьютов и
   * чёрного списка. Чистка текста (эмоуты, ссылки, антиспам, стоп-слова, длина) остаётся.
   */
  private relaxed(m: ChatMessage): FilterOutcome {
    const s = structuredClone(this.settings) as Settings
    s.tts.enabled = true
    s.filters.prefix.enabled = false
    s.filters.roles = { ...s.filters.roles, everyone: true }
    s.filters.userCooldownSec = 0
    s.filters.duplicateSec = 0
    s.filters.blacklist = []
    s.filters.maxQueue = 500
    s.filters.trigger = 'prefix'
    s.mutes = []
    // Если в сообщении есть префикс - срезаем его, как обычно (в ответе - после "@ник").
    const raw = stripReplyMention(m.text.trim(), m)
    const prefix = matchPrefix(raw, this.settings.filters.prefix.list)
    const text = prefix ? raw.slice(prefix.length) : raw
    // Уже срезали "@ник": пайплайн не должен искать его снова.
    return runFilters({ ...m, text, reply: null }, s, createFilterState(), {
      now: this.now(),
      queueLength: 0,
      isThirdPartyEmote: (w) => this.emotes.has(w),
      twitchEmotes: twitchEmoteNames(m)
    })
  }

  /** Кнопка "озвучить" у сообщения в ленте: в очередь вне фильтров, перед обычным чатом. */
  speakManually(messageId: string): Result<null> {
    const e = this.feed.get(messageId)
    if (!e) return { ok: false, error: 'Сообщение уже ушло из ленты.' }
    // Удалённое модератором (или после бана, таймаута, очистки чата) не звучит и вручную.
    if (e.status === 'deleted')
      return { ok: false, error: 'Сообщение удалено модератором, озвучить его нельзя.' }
    const r = this.relaxed(e.message)
    if (!r.pass) return { ok: false, error: `Не прошло фильтры (${r.reason}).` }
    this.feed.setStatus(messageId, 'queued', null, r.text)
    this.emit('feed', [{ ...e }])
    this.queue.enqueue(e.message, r.text, { priority: PRIORITY.manual, source: 'manual' })
    this.journal.add('info', `Вручную в очередь: ${e.message.displayName}`)
    return { ok: true, value: null }
  }

  /** Мьют зрителя на N минут: его сообщения не озвучиваются, уже стоящие в очереди убираются. */
  mute(login: string, minutes: number): Result<null> {
    const user = login.trim().toLowerCase()
    if (!user) return { ok: false, error: 'Не указан ник.' }
    // От 1 минуты до года: огромное число сломало бы файл настроек.
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525_600)
      return { ok: false, error: 'Неверный срок мьюта: можно от 1 минуты до года.' }
    const until = this.now() + minutes * 60_000
    this.store.setMute(user, until, this.now())
    const n = this.queue.removeByUser(user, `мьют до ${hhmm(until)}`)
    this.journal.add(
      'info',
      `${user}: мьют на ${formatMinutes(minutes)} (до ${hhmm(until)})${n ? `, убрано из очереди: ${n}` : ''}`
    )
    return { ok: true, value: null }
  }

  unmute(login: string): Result<null> {
    if (!this.store.removeMute(login)) return { ok: false, error: `${login} не в мьюте.` }
    this.journal.add('info', `${login}: мьют снят`)
    return { ok: true, value: null }
  }

  /** Чёрный список: насовсем (пока не уберут вручную). */
  blacklist(login: string, on: boolean): Result<null> {
    const user = login.trim().toLowerCase()
    if (!user) return { ok: false, error: 'Не указан ник.' }
    this.store.setBlacklisted(user, on)
    if (on) {
      const n = this.queue.removeByUser(user, 'в чёрном списке')
      this.journal.add(
        'info',
        `${user} добавлен в чёрный список${n ? `, убрано из очереди: ${n}` : ''}`
      )
    } else this.journal.add('info', `${user} убран из чёрного списка`)
    return { ok: true, value: null }
  }

  /**
   * Проверка текста без чата: что стало бы с сообщением. Состояние (кулдаун, дубли) не меняется,
   * а кулдаун и дубли для проверки не учитываются.
   */
  testMessage(text: string): FilterOutcome {
    const m: ChatMessage = {
      id: `test-${this.now()}`,
      user: '__test__',
      displayName: 'Проверка',
      text,
      badges: ['broadcaster'],
      color: null,
      emotes: [],
      subMonths: null,
      reply: null,
      rewardId: null,
      isAction: false,
      timestamp: this.now()
    }
    return runFilters(m, this.settings as Settings, createFilterState(), {
      now: this.now(),
      queueLength: 0,
      isThirdPartyEmote: (w) => this.emotes.has(w)
    })
  }

  stop(): void {
    this.chat.stop()
    this.emotes.stop()
  }
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} мин`
  if (min <= 1440) return `${Math.round(min / 60)} ч`
  return `${Math.round(min / 1440)} сут.`
}
