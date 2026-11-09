// Общие типы данных для main, preload и renderer.

/** Значки Twitch: роли для фильтров и значки у ника в ленте. prime - Prime Gaming у зрителя. */
export type Badge = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'prime'

/** Ответ на сообщение: кому отвечают (теги reply-parent-* у Twitch). */
export interface ReplyInfo {
  user: string
  displayName: string
  /** Текст сообщения, на которое ответили. */
  text: string
}

/**
 * Диапазон эмоута Twitch в тексте сообщения.
 * Индексы в кодовых точках Unicode (не в UTF-16), включительно - так их отдаёт Twitch.
 */
export interface EmoteRange {
  id: string
  start: number
  end: number
}

/** Сообщение чата после преобразования из события Twitch. */
export interface ChatMessage {
  id: string
  /** Логин в нижнем регистре. */
  user: string
  displayName: string
  text: string
  badges: Badge[]
  /** Сколько месяцев подписан (из badge-info), null - не подписчик или Twitch не прислал. */
  subMonths: number | null
  /** Сообщение - ответ на другое. Twitch тогда сам ставит "@ник " в начало текста. */
  reply: ReplyInfo | null
  /** Сообщение пришло через награду за баллы с вводом текста: id награды, иначе null. */
  rewardId: string | null
  /** Цвет ника в формате #RRGGBB или null, если не задан. */
  color: string | null
  emotes: EmoteRange[]
  /** Сообщение через /me. */
  isAction: boolean
  /** Время прихода, мс с эпохи. */
  timestamp: number
}

/** Состояние подключения к чату. */
export type ChatState = 'idle' | 'connecting' | 'joining' | 'connected' | 'reconnecting' | 'error'

export interface ChatStatus {
  state: ChatState
  channel: string
  /** Пояснение для человека: что происходит и что делать. */
  detail: string | null
}

/** Статус сообщения в ленте "Весь чат". */
export type FeedStatus =
  | 'no-prefix' // без префикса: не для озвучки
  | 'accepted' // прошло фильтры и встало в очередь
  | 'queued'
  | 'speaking' // озвучивается прямо сейчас
  | 'spoken'
  | 'skipped' // было в очереди, но не прозвучало (пропуск, мьют, лимит, ошибка)
  | 'rejected'
  | 'deleted' // удалено модератором, бан или таймаут

export interface FeedEntry {
  message: ChatMessage
  status: FeedStatus
  /** Причина отказа или удаления. */
  reason: string | null
  /** Текст после фильтров (что прозвучит). */
  finalText: string | null
}

/** Состояние загрузки сторонних эмоутов (7TV, BTTV, FFZ). */
export interface EmoteProviderStatus {
  provider: '7TV' | 'BTTV' | 'FFZ'
  state: 'idle' | 'loading' | 'ok' | 'error'
  count: number
  error: string | null
}

/** Жизненный цикл элемента очереди. */
export type QueueStatus =
  'queued' | 'synthesizing' | 'ready' | 'playing' | 'done' | 'skipped' | 'failed'

/** Откуда сообщение в очереди. */
export type QueueSource = 'chat' | 'manual' | 'reward'

/** Элемент очереди для показа в окне (без аудио). */
export interface QueueItemView {
  id: string
  message: ChatMessage
  /** Текст после фильтров, который озвучивается. */
  text: string
  status: QueueStatus
  /** Причина пропуска или текст ошибки. */
  reason: string | null
  priority: number
  source: QueueSource
  durationSec: number | null
  /** Когда началось проигрывание (мс), для полоски прогресса. */
  startedAt: number | null
}

export interface QueueSnapshot {
  /** Что звучит сейчас. */
  current: QueueItemView | null
  /** Ждут своей очереди, в порядке проигрывания. */
  items: QueueItemView[]
  /** Последние завершённые (прозвучали, пропущены, ошибки), новые сверху. */
  history: QueueItemView[]
  paused: boolean
  /** Почему на паузе (для подписи "На паузе: ..."), null - не на паузе. */
  pauseReason: string | null
  /** Пауза из-за ошибки (ключ, деньги, голос, OBS), а не по кнопке "Пауза". */
  pausedByError: boolean
  /**
   * Сервис озвучки временно не отвечает: сообщения ждут в очереди, программа сама пробует
   * снова. Текст для подписи под очередью, null - всё в порядке.
   */
  stalled: string | null
  /** Без звука (нет ключа Fish), длительность примерная. */
  silent: boolean
}

/** Запись журнала действий (под очередью). */
export interface JournalEntry {
  id: number
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}

/** Мьют зрителя: его сообщения не озвучиваются до указанного времени. */
export interface MuteEntry {
  login: string
  /** До какого момента (мс). */
  until: number
}

/** Результат операции, которая может не получиться: всегда с понятной причиной. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** Состояние обновления программы (без поля current). */
export type UpdateState =
  | { state: 'off'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest' }
  /** startup - найдено при запуске: окно "Обновить / Выйти". Иначе - тихая пометка в меню. */
  | { state: 'available'; version: string; notes: string; sizeMb: number; startup: boolean }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  /** Распаковка перед закрытием программы. */
  | { state: 'installing'; version: string; percent: number }
  | { state: 'error'; error: string }

export type UpdateStatus = UpdateState & { current: string }

/** Что пользователь написал в форме "Сообщить о проблеме". */
export interface FeedbackDraft {
  kind: 'bug' | 'idea'
  text: string
  /** Как связаться для ответа (по желанию): Telegram, почта. */
  contact: string
  /** Приложить последние строки журнала (очищенные от личных данных). */
  attachLog: boolean
}

/** Отчёт ровно в том виде, в каком уйдёт автору. */
export interface FeedbackReport {
  kind: 'bug' | 'idea'
  text: string
  contact: string
  appVersion: string
  /** Версия Windows, например "Windows 10.0.26200". */
  os: string
  /** Когда отправлено, по часам пользователя: "08.11.2026 21:32 (UTC+3)". Совпадает со временем в журнале. */
  sentAt: string
  log: string
}

/** Расходы на синтез за эту сессию программы. */
export interface TtsStats {
  /** Запросов к Fish (без кэша). */
  requests: number
  /** Взято из кэша без запроса. */
  cacheHits: number
  /** Байт текста UTF-8 отправлено (так считает деньги Fish). */
  bytes: number
  costUsd: number
}

/** Состояние Fish Audio для показа в окне. */
export interface FishStatus {
  /** ok - ключ есть; env - ключ из .env (только разработка); none - нет; unreadable - не расшифровался. */
  key: 'ok' | 'env' | 'none' | 'unreadable'
  /** Баланс API, $ (строкой как у Fish), null - ещё не знаем. */
  balance: string | null
  /** Последняя ошибка Fish (ключ, деньги, связь), null - всё хорошо. */
  error: string | null
  /**
   * Проверен ли ключ запросом к Fish: works - принят, rejected - Fish его не принял,
   * unknown - ещё не проверяли или проверить не удалось (нет связи).
   */
  keyCheck: 'unknown' | 'works' | 'rejected'
  stats: TtsStats
  budget: BudgetStatus
}

/** Дневной бюджет на платные модели для показа в окне. */
export interface BudgetStatus {
  /** Лимит действует: выбрана платная модель и лимит больше 0. */
  active: boolean
  spentUsd: number
  limitUsd: number
  /** Лимит исчерпан: сейчас читает бесплатная модель или озвучка на паузе (см. onLimit). */
  exceeded: boolean
  onLimit: 'free' | 'pause'
}

/** Голос Fish для поиска и избранного. */
export interface VoiceInfo {
  id: string
  title: string
  languages: string[]
  author: string
  uses: number
}

/** Один шаг проверки озвучки: чат, очередь, звук, сервер Fish, ключ, пробная озвучка. */
export interface CheckStep {
  title: string
  state: 'ok' | 'warn' | 'fail' | 'skip'
  /** Сколько занял шаг, мс. */
  ms: number | null
  detail: string
  /** Что сделать, если шаг не прошёл. */
  fix?: string
}

export interface ConnectionCheck {
  steps: CheckStep[]
  /** Итог для человека: работает ли озвучка и что делать. */
  verdict: string
  ok: boolean
}

export type HotkeyAction = 'skip' | 'pause' | 'toggle'

/** Состояние горячей клавиши: зарегистрирована или почему нет. */
export interface HotkeyStatus {
  action: HotkeyAction
  accelerator: string
  ok: boolean
  error: string | null
}

/** Состояние локальной страницы для OBS (оверлей и звук). */
export interface OverlayStatus {
  /** Адрес для источника "Браузер" в OBS. */
  url: string
  running: boolean
  /** Сколько открыто страниц (источников OBS) сейчас. */
  clients: number
  /** Почему не запустилась (порт занят и т.п.). */
  error: string | null
}
