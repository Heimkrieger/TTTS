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
  QueueStatus
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
}

export interface QueueEvents {
  update: [QueueSnapshot]
  /** Элемент сменил состояние (для ленты чата). */
  item: [QueueItemView]
  /** Сообщение для журнала действий. */
  journal: [level: 'info' | 'warn' | 'error', text: string]
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
      abort: null
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

  /** Модератор удалил сообщение: убрать из очереди, а если звучит - остановить. */
  removeByMessageId(messageId: string, reason: string): void {
    for (const it of [...this.items, ...(this.current ? [this.current] : [])]) {
      if (it.message.id === messageId) this.remove(it.id, reason)
    }
  }

  /** Бан, таймаут, мьют: убрать все сообщения зрителя. Возвращает сколько убрано. */
  removeByUser(login: string, reason: string): number {
    let n = 0
    for (const it of [...this.items, ...(this.current ? [this.current] : [])]) {
      if (it.message.user === login && this.remove(it.id, reason)) n++
    }
    return n
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
  replayLast(): QueueItemView | null {
    const last = this.history.find((x) => x.status === 'done')
    return last ? this.replay(last.id) : null
  }

  /**
   * Повторить сообщение из истории: в начало очереди. Аудио есть в памяти - играется сразу;
   * нет - синтез заново, и если голос и настройки те же, звук берётся из кэша без запроса к Fish.
   */
  replay(itemId: string): QueueItemView | null {
    const last = this.history.find((x) => x.id === itemId)
    if (!last) return null
    const copy: Item = {
      ...last,
      id: `q${++seq}`,
      status: last.audio || this.silent ? 'ready' : 'queued',
      reason: null,
      startedAt: null,
      source: 'manual',
      abort: null
    }
    this.items.unshift(copy)
    this.emit('journal', 'info', `Повтор: ${last.message.displayName}`)
    this.changed()
    this.pump()
    return view(copy)
  }

  /** Вся история (до HISTORY_SIZE), новые сверху. */
  fullHistory(): QueueItemView[] {
    return this.history.map(view)
  }

  stop(): void {
    this.stopped = true
    if (this.waitTimer) clearTimeout(this.waitTimer)
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

  /** Главный цикл: синтез заранее + запуск следующего. */
  private pump(): void {
    if (this.stopped) return
    if (!this.fatalPause) this.prefetch()
    if (this.current || this.paused || this.waitTimer) return
    const next = this.items[0]
    if (!next || next.status !== 'ready') return
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
    } catch (e) {
      if (!this.items.includes(item)) return
      const msg = e instanceof Error ? e.message : String(e)
      if (isFatal(e)) {
        // Неверный ключ или нет денег: дальше всё равно не получится. Сообщение остаётся в очереди,
        // очередь встаёт на паузу; после исправления - "Продолжить".
        item.abort = null
        this.setStatus(item, 'queued', null)
        this.pauseOnError(msg)
        this.changed()
        return
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

/** Ошибка, после которой очередь встаёт на паузу (поле fatal: true, например FishFatalError). */
function isFatal(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { fatal?: unknown }).fatal === true
}
