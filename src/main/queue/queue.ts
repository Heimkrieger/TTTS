// Очередь озвучки.
//
// Жизненный цикл: queued -> synthesizing -> ready -> playing -> done.
// Из любого состояния: skipped (с причиной) или failed (с текстом ошибки).
//
// Порядок = порядок массива items: новое сообщение встаёт после всех с таким же или большим
// приоритетом. "Поднять в начало" просто переставляет элемент. Пока играет текущее,
// следующие (не больше MAX_PARALLEL_SYNTH) синтезируются заранее.
import { EventEmitter } from 'node:events'
import type {
  ChatMessage,
  QueueItemView,
  QueueSnapshot,
  QueueSource,
  QueueStatus,
  Result
} from '@shared/types'

/** Примерная скорость речи на скорости 1.0: символов в секунду (для оценки до синтеза). */
export const CHARS_PER_SEC = 14
export const MAX_PARALLEL_SYNTH = 2
/** История "что прозвучало": последние 500. Аудио в памяти только у последних 5. */
export const HISTORY_SIZE = 500
/** Сколько последних из истории уходит в снимок очереди (полная история - отдельным запросом). */
export const SNAPSHOT_HISTORY = 30
/** Затухание при пропуске, мс. */
export const SKIP_FADE_MS = 150
/**
 * Сервис озвучки не отвечает (нет сети, перегрузка): паузы перед следующей попыткой, мс.
 * Сообщения при этом не теряются, а ждут в очереди.
 */
export const STALL_MS = [5000, 10_000, 20_000, 40_000, 60_000]
/** Сообщение падает само по себе (у других получается): столько попыток и хватит. */
export const ITEM_TRIES = 3
/** Потолок попыток на одно сообщение, даже если не получается ни у кого. */
export const ITEM_TRIES_MAX = 8

export interface SynthResult {
  /** null - звука нет (беззвучный режим без ключа Fish). */
  audio: Buffer | null
  durationSec: number
}

export interface TtsProvider {
  synthesize(text: string, opts: { speed: number; signal: AbortSignal }): Promise<SynthResult>
}

export interface Player {
  /** Играть до конца. Результат: доиграло или остановлено. */
  play(item: {
    audio: Buffer | null
    durationSec: number
    volume: number
    trimSec: number | null
  }): Promise<'ended' | 'stopped'>
  stop(fadeMs: number): void
  pause(): void
  resume(): void
}

export interface QueueSettings {
  speed: number
  volume: number
  pauseBetweenMs: number
  /**
   * Сколько сообщение из чата ждёт после прихода, прежде чем зазвучать, мс. За это время бот
   * или модератор успевает его удалить, и тогда оно не звучит вовсе. Синтез идёт заранее.
   */
  chatDelayMs: number
  maxDurationSec: number
  overLimit: 'skip' | 'trim'
}

interface Item {
  id: string
  message: ChatMessage
  text: string
  status: QueueStatus
  reason: string | null
  priority: number
  source: QueueSource
  durationSec: number | null
  audio: Buffer | null
  startedAt: number | null
  /** Обрезать до стольких секунд (режим "обрезать"). */
  trimSec: number | null
  abort: AbortController | null
  /** Когда встало в очередь (часы очереди): от этого считается задержка перед озвучкой. */
  addedAt: number
  /** Сколько раз синтез срывался из-за связи и каким был счётчик удач при первом срыве. */
  tries: number
  okSeqAtFail: number
}

export interface QueueEvents {
  update: [QueueSnapshot]
  /** Элемент сменил состояние (для ленты чата). */
  item: [QueueItemView]
  /** Сообщение для журнала действий. */
  journal: [level: 'info' | 'warn' | 'error', text: string]
  /** Очередь встала на паузу из-за ошибки: сама ошибка (чтобы показать её там, где её ждут). */
  fatal: [error: unknown]
  /** Нажали "Продолжить". */
  resumed: []
}

let seq = 0

export class TtsQueue extends EventEmitter<QueueEvents> {
  private items: Item[] = []
  private current: Item | null = null
  private history: Item[] = []
  private paused = false
  /** Почему очередь на паузе: нажали "Пауза" или ошибка, после которой дальше не получится. */
  private pauseReason: string | null = null
  /** Пауза из-за ошибки (ключ, деньги, лимит, OBS): заранее не синтезируем, чтобы не долбить Fish. */
  private fatalPause = false
  private waitTimer: ReturnType<typeof setTimeout> | null = null
  /** Ждём, пока у первого в очереди выйдет задержка перед озвучкой. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Сообщения, удалённые модератором (сам удалил, бан, таймаут, очистка чата). Они больше не
   * звучат ни из очереди, ни повтором из истории.
   */
  private deletedIds = new Set<string>()
  /** Сервис озвучки не отвечает: ждём до следующей попытки, синтез пока не запускаем. */
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private stallReason: string | null = null
  /** Сколько срывов связи подряд и сколько всего удачных синтезов. */
  private netFails = 0
  private okSeq = 0
  private stopped = false

  constructor(
    private provider: TtsProvider,
    private player: Player,
    private readonly getSettings: () => QueueSettings,
    private silent: boolean,
    private readonly now: () => number = Date.now
  ) {
    super()
  }

  /** Сменить синтез и проигрывание (например, когда появится ключ Fish). */
  setBackend(provider: TtsProvider, player: Player, silent: boolean): void {
    this.provider = provider
    this.player = player
    this.silent = silent
    this.changed()
  }

  get length(): number {
    return this.items.length
  }

  // ---------- добавление ----------

  enqueue(
    message: ChatMessage,
    text: string,
    opts: { priority?: number; source?: QueueSource } = {}
  ): QueueItemView {
    const priority = opts.priority ?? 0
    const item: Item = {
      id: `q${++seq}`,
      message,
      text,
      status: 'queued',
      reason: null,
      priority,
      source: opts.source ?? 'chat',
      durationSec: null,
      audio: null,
      startedAt: null,
      trimSec: null,
      abort: null,
      addedAt: this.now(),
      tries: 0,
      okSeqAtFail: 0
    }
    // Модератор уже удалил это сообщение: не звучит, как бы оно сюда ни попало.
    if (this.deletedIds.has(message.id)) {
      item.status = 'skipped'
      item.reason = 'удалено модератором'
      this.toHistory(item)
      this.emit('item', view(item))
      this.changed()
      return view(item)
    }
    // Оценка до синтеза: если точно длиннее лимита - не тратим деньги на запрос.
    const s = this.getSettings()
    const estimate = text.length / CHARS_PER_SEC / s.speed
    if (s.overLimit === 'skip' && estimate > s.maxDurationSec) {
      item.status = 'skipped'
      item.reason = `длиннее лимита: примерно ${Math.round(estimate)} с, можно ${s.maxDurationSec} с`
      this.toHistory(item)
      this.emit('item', view(item))
      this.changed()
      return view(item)
    }
    const idx = this.items.findIndex((x) => x.priority < priority)
    if (idx === -1) this.items.push(item)
    else this.items.splice(idx, 0, item)
    this.emit('item', view(item))
    this.changed()
    this.pump()
    return view(item)
  }

  // ---------- управление ----------

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.pauseReason = 'вы нажали "Пауза"'
    if (this.current) this.player.pause()
    this.emit('journal', 'info', 'Озвучка на паузе')
    this.changed()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.pauseReason = null
    this.fatalPause = false
    if (this.current) this.player.resume()
    this.emit('journal', 'info', 'Озвучка продолжена')
    this.emit('resumed')
    this.changed()
    this.pump()
  }

  /** Пропустить то, что звучит сейчас. */
  skipCurrent(reason = 'пропущено вручную'): void {
    const cur = this.current
    if (!cur) return
    cur.reason = reason
    this.player.stop(SKIP_FADE_MS)
  }

  /** Убрать сообщение из очереди или остановить, если оно звучит. */
  remove(id: string, reason = 'убрано из очереди вручную'): boolean {
    if (this.current?.id === id) {
      this.skipCurrent(reason)
      return true
    }
    const idx = this.items.findIndex((x) => x.id === id)
    if (idx === -1) return false
    const [item] = this.items.splice(idx, 1)
    if (!item) return false
    this.finish(item, 'skipped', reason)
    this.changed()
    this.pump()
    return true
  }

  /**
   * Модератор удалил сообщение: убрать из очереди, а если звучит - остановить. Повторить его
   * из истории тоже будет нельзя.
   */
  removeByMessageId(messageId: string, reason: string): void {
    // Запоминаем id, даже если сообщения в очереди не было: позже его могут поставить вручную.
    this.deletedIds.add(messageId)
    this.markDeleted((m) => m.id === messageId)
    for (const it of [...this.items, ...(this.current ? [this.current] : [])]) {
      if (it.message.id === messageId) this.remove(it.id, reason)
    }
  }

  /**
   * Убрать все сообщения зрителя. Возвращает сколько убрано. moderated - это бан или таймаут
   * (Twitch стёр его сообщения в чате): тогда и повтор из истории запрещён. Мьют и чёрный
   * список в программе сообщения в чате не стирают, повтор остаётся.
   */
  removeByUser(login: string, reason: string, moderated = false): number {
    if (moderated) this.markDeleted((m) => m.user === login)
    let n = 0
    for (const it of [...this.items, ...(this.current ? [this.current] : [])]) {
      if (it.message.user === login && this.remove(it.id, reason)) n++
    }
    return n
  }

  /** Модератор очистил весь чат: всё убрать, повторять прежние сообщения нельзя. */
  clearChat(reason: string): number {
    this.markDeleted(() => true)
    return this.clear(reason)
  }

  private markDeleted(match: (m: ChatMessage) => boolean): void {
    for (const it of [...this.items, ...this.history, ...(this.current ? [this.current] : [])]) {
      if (match(it.message)) this.deletedIds.add(it.message.id)
    }
    // Список растёт весь стрим: держим не больше, чем помнит история, с запасом.
    if (this.deletedIds.size > HISTORY_SIZE * 4) {
      const keep = [...this.deletedIds].slice(-HISTORY_SIZE * 2)
      this.deletedIds = new Set(keep)
    }
  }

  /** Очистить очередь (то, что звучит, тоже останавливается). */
  clear(reason = 'очередь очищена'): number {
    const n = this.items.length + (this.current ? 1 : 0)
    for (const it of this.items.splice(0)) this.finish(it, 'skipped', reason)
    if (this.current) this.skipCurrent(reason)
    this.changed()
    return n
  }

  moveToTop(id: string): boolean {
    const idx = this.items.findIndex((x) => x.id === id)
    if (idx <= 0) return idx === 0
    const [item] = this.items.splice(idx, 1)
    if (!item) return false
    this.items.unshift(item)
    this.changed()
    this.pump()
    return true
  }

  /** Повторить последнее прозвучавшее (из готового аудио, без нового запроса). */
  replayLast(): Result<QueueItemView> {
    const last = this.history.find((x) => x.status === 'done')
    if (!last) return { ok: false, error: 'Повторять нечего: ещё ничего не прозвучало' }
    return this.replay(last.id)
  }

  /**
   * Повторить сообщение из истории: в начало очереди. Аудио есть в памяти - играется сразу;
   * нет - синтез заново, и если голос и настройки те же, звук берётся из кэша без запроса к Fish.
   */
  replay(itemId: string): Result<QueueItemView> {
    const last = this.history.find((x) => x.id === itemId)
    if (!last)
      return { ok: false, error: 'Этого сообщения уже нет в истории (хранятся последние 500)' }
    if (this.deletedIds.has(last.message.id))
      return {
        ok: false,
        error: `Сообщение ${last.message.displayName} удалено модератором (или за бан, таймаут, очистку чата), повторять его нельзя`
      }
    const copy: Item = {
      ...last,
      id: `q${++seq}`,
      status: last.audio || this.silent ? 'ready' : 'queued',
      reason: null,
      startedAt: null,
      source: 'manual',
      abort: null,
      addedAt: this.now(),
      tries: 0,
      okSeqAtFail: 0
    }
    this.items.unshift(copy)
    this.emit('journal', 'info', `Повтор: ${last.message.displayName}`)
    this.changed()
    this.pump()
    return { ok: true, value: view(copy) }
  }

  /** Вся история (до HISTORY_SIZE), новые сверху. */
  fullHistory(): QueueItemView[] {
    return this.history.map(view)
  }

  stop(): void {
    this.stopped = true
    if (this.waitTimer) clearTimeout(this.waitTimer)
    if (this.holdTimer) clearTimeout(this.holdTimer)
    if (this.stallTimer) clearTimeout(this.stallTimer)
    for (const it of this.items) it.abort?.abort()
    if (this.current) this.player.stop(0)
  }

  snapshot(): QueueSnapshot {
    return {
      current: this.current ? view(this.current) : null,
      items: this.items.map(view),
      history: this.history.slice(0, SNAPSHOT_HISTORY).map(view),
      paused: this.paused,
      pauseReason: this.paused ? this.pauseReason : null,
      stalled: this.stallReason,
      silent: this.silent
    }
  }

  // ---------- внутреннее ----------

  private changed(): void {
    this.emit('update', this.snapshot())
  }

  private setStatus(item: Item, status: QueueStatus, reason: string | null = item.reason): void {
    item.status = status
    item.reason = reason
    this.emit('item', view(item))
  }

  private finish(item: Item, status: 'done' | 'skipped' | 'failed', reason: string | null): void {
    item.abort?.abort()
    item.abort = null
    this.setStatus(item, status, reason)
    this.toHistory(item)
  }

  private toHistory(item: Item): void {
    this.history.unshift(item)
    // Аудио храним только у последних, чтобы не держать память весь стрим.
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE
    for (const h of this.history.slice(5)) h.audio = null
  }

  /**
   * Пауза из-за ошибки, после которой дальше не получится (ключ, деньги, лимит, OBS не подключён).
   * Пишется в журнал всегда, даже если очередь уже стояла на паузе вручную.
   */
  private pauseOnError(msg: string): void {
    const again = this.fatalPause && this.pauseReason === msg
    this.fatalPause = true
    this.pauseReason = msg
    if (!this.paused) {
      this.paused = true
      if (this.current) this.player.pause()
    }
    if (!again) this.emit('journal', 'error', `Озвучка на паузе: ${msg}`)
  }

  /**
   * Сервис озвучки не ответил: пауза перед следующей попыткой растёт от 5 с до минуты.
   * Если ожидание уже идёт (два запроса сорвались разом), второе не заводим.
   */
  private stall(brief: string): void {
    this.netFails++
    if (this.stallTimer) return
    const ms = STALL_MS[Math.min(this.netFails - 1, STALL_MS.length - 1)] ?? 60_000
    if (this.stallReason === null)
      this.emit(
        'journal',
        'warn',
        `Озвучка ждёт: ${brief}. Сообщения не теряются, программа пробует снова сама`
      )
    this.stallReason = `${brief}, следующая попытка через ${Math.round(ms / 1000)} с`
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      this.pump()
    }, ms)
  }

  /** Главный цикл: синтез заранее + запуск следующего. */
  private pump(): void {
    if (this.stopped) return
    if (!this.fatalPause && !this.stallTimer) this.prefetch()
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    if (this.current || this.paused || this.waitTimer) return
    const next = this.items[0]
    if (!next || next.status !== 'ready') return
    // Сообщение из чата сначала выжидает: вдруг его удалят. Своё (повтор, проверка) - сразу.
    if (next.source === 'chat' || next.source === 'reward') {
      const left = next.addedAt + this.getSettings().chatDelayMs - this.now()
      if (left > 0) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null
          this.pump()
        }, left)
        return
      }
    }
    if (this.deletedIds.has(next.message.id)) {
      // Защита на всякий случай: удалённое не звучит, даже если как-то осталось в очереди.
      this.items.shift()
      this.finish(next, 'skipped', 'удалено модератором')
      this.changed()
      this.pump()
      return
    }
    this.items.shift()
    void this.playItem(next)
  }

  private prefetch(): void {
    const busy = this.items.filter((x) => x.status === 'synthesizing').length
    let free = MAX_PARALLEL_SYNTH - busy
    for (const it of this.items.slice(0, MAX_PARALLEL_SYNTH)) {
      if (free <= 0) break
      if (it.status !== 'queued') continue
      free--
      void this.synth(it)
    }
  }

  private async synth(item: Item): Promise<void> {
    const s = this.getSettings()
    item.abort = new AbortController()
    this.setStatus(item, 'synthesizing')
    this.changed()
    try {
      const r = await this.provider.synthesize(item.text, {
        speed: s.speed,
        signal: item.abort.signal
      })
      if (!this.items.includes(item)) return // убрали, пока синтезировалось
      item.audio = r.audio
      item.durationSec = r.durationSec
      if (r.durationSec > s.maxDurationSec) {
        if (s.overLimit === 'skip') {
          this.items.splice(this.items.indexOf(item), 1)
          this.finish(
            item,
            'skipped',
            `длиннее лимита: ${Math.round(r.durationSec)} с, можно ${s.maxDurationSec} с`
          )
          this.changed()
          this.pump()
          return
        }
        item.trimSec = s.maxDurationSec
      }
      item.abort = null
      this.setStatus(item, 'ready')
      this.okSeq++
      if (this.netFails > 0) {
        this.netFails = 0
        this.stallReason = null
        // Связь есть: остальные сообщения не ждут конца паузы.
        if (this.stallTimer) clearTimeout(this.stallTimer)
        this.stallTimer = null
        this.emit('journal', 'info', 'Связь с сервисом озвучки вернулась, озвучка продолжается')
      }
    } catch (e) {
      if (!this.items.includes(item)) return
      const msg = e instanceof Error ? e.message : String(e)
      if (isFatal(e)) {
        // Неверный ключ или нет денег: дальше всё равно не получится. Сообщение остаётся в очереди,
        // очередь встаёт на паузу; после исправления - "Продолжить".
        item.abort = null
        this.setStatus(item, 'queued', null)
        this.pauseOnError(msg)
        this.emit('fatal', e)
        this.changed()
        return
      }
      const brief = transientBrief(e)
      if (brief !== null) {
        // Нет сети или сервис перегружен: сообщение не теряем. Ждём и пробуем снова; пока ждём,
        // новые запросы не отправляем. То, что уже готово, продолжает звучать.
        if (item.tries === 0) item.okSeqAtFail = this.okSeq
        item.tries++
        const itsOwnFault = item.tries >= ITEM_TRIES && this.okSeq !== item.okSeqAtFail
        this.stall(brief)
        if (!itsOwnFault && item.tries < ITEM_TRIES_MAX) {
          item.abort = null
          this.setStatus(item, 'queued', null)
          this.changed()
          return
        }
      }
      this.items.splice(this.items.indexOf(item), 1)
      this.finish(item, 'failed', msg)
      this.emit('journal', 'error', `Не озвучено сообщение ${item.message.displayName}: ${msg}`)
    }
    this.changed()
    this.pump()
  }

  private async playItem(item: Item): Promise<void> {
    const s = this.getSettings()
    this.current = item
    item.startedAt = this.now()
    item.reason = null
    this.setStatus(item, 'playing')
    this.changed()
    this.prefetch()
    let result: 'ended' | 'stopped'
    try {
      result = await this.player.play({
        audio: item.audio,
        durationSec: item.durationSec ?? 1,
        volume: s.volume,
        trimSec: item.trimSec
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isFatal(e)) {
        // OBS не подключён или отключился посреди звука: сообщение не теряется, встаёт первым,
        // очередь на паузу. После подключения - "Продолжить".
        this.current = null
        item.startedAt = null
        this.items.unshift(item)
        this.setStatus(item, 'ready', null)
        this.pauseOnError(msg)
        this.emit('fatal', e)
        this.changed()
        return
      }
      result = 'stopped'
      item.reason = `не проигралось: ${msg}`
      this.emit(
        'journal',
        'error',
        `Не проигралось сообщение ${item.message.displayName}: ${msg}. Проверьте устройство в разделе "Звук".`
      )
    }
    this.current = null
    if (result === 'ended') this.finish(item, 'done', null)
    else this.finish(item, 'skipped', item.reason ?? 'остановлено')
    this.changed()
    // Пауза между сообщениями.
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null
      this.pump()
    }, this.getSettings().pauseBetweenMs)
  }
}

function view(i: Item): QueueItemView {
  return {
    id: i.id,
    message: i.message,
    text: i.text,
    status: i.status,
    reason: i.reason,
    priority: i.priority,
    source: i.source,
    durationSec: i.durationSec,
    startedAt: i.startedAt
  }
}

/**
 * Временный сбой (поле transient: true, например нет связи с Fish): короткое описание для
 * подписи под очередью. null - ошибка не временная.
 */
function transientBrief(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const o = e as { transient?: unknown; brief?: unknown }
  if (o.transient !== true) return null
  return typeof o.brief === 'string' && o.brief ? o.brief : 'сервис озвучки не отвечает'
}

/** Ошибка, после которой очередь встаёт на паузу (поле fatal: true, например FishFatalError). */
function isFatal(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { fatal?: unknown }).fatal === true
}
