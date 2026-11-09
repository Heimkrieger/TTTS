// Проигрывание через окно (Web Audio в renderer). Main отправляет аудио и ждёт сигнал "доиграло".
// Если окно не ответило (закрыто, зависло) - через оставшуюся длительность + 10 с считаем, что
// доиграло, и пишем об этом в журнал, чтобы очередь не встала навсегда.
import type { Player } from '../queue/queue'

export interface PlayerBridge {
  /** Отправить команду в окно. false - окна нет. */
  send(channel: 'play' | 'stop' | 'pause' | 'resume' | 'volume', payload: unknown): boolean
}

const NO_ANSWER =
  'Сообщение доиграло не как обычно (окно не ответило), программа перешла к следующему. Если повторяется, проверьте устройство в разделе "Звук".'

/** Столько сообщений подряд без ответа окна - звук явно не играет: очередь встаёт на паузу. */
export const MISSES_TO_PAUSE = 2

/** Окно программы не отвечает: очередь видит fatal и встаёт на паузу, сообщение не теряется. */
export class WindowSilentError extends Error {
  readonly fatal = true
}

let seq = 0

export class RendererPlayer implements Player {
  private waiting: {
    id: number
    resolve: (r: 'ended' | 'stopped') => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout> | null
    /** Когда сработает страховка (мс) и сколько оставалось на момент паузы. */
    deadline: number
    leftMs: number
  } | null = null
  private paused = false
  /** Сколько сообщений подряд окно не подтвердило. */
  private misses = 0

  constructor(
    private readonly bridge: PlayerBridge,
    private readonly onWarn: (text: string) => void
  ) {}

  play(item: {
    audio: Buffer | null
    durationSec: number
    volume: number
    trimSec: number | null
  }): Promise<'ended' | 'stopped'> {
    if (!item.audio) return Promise.resolve('ended')
    const id = ++seq
    this.paused = false
    return new Promise((resolve, reject) => {
      const ok = this.bridge.send('play', {
        id,
        audio: new Uint8Array(item.audio as Buffer),
        volume: item.volume,
        trimSec: item.trimSec
      })
      if (!ok) {
        reject(new Error('окно программы закрыто, звук некуда выводить'))
        return
      }
      const limit = (Math.min(item.durationSec, item.trimSec ?? Infinity) + 10) * 1000
      this.waiting = { id, resolve, reject, timer: null, deadline: 0, leftMs: limit }
      this.arm()
    })
  }

  private arm(): void {
    const w = this.waiting
    if (!w) return
    w.deadline = Date.now() + w.leftMs
    w.timer = setTimeout(() => {
      if (++this.misses >= MISSES_TO_PAUSE) {
        // Второе сообщение подряд без ответа: окно зависло или упало. Не делаем вид, что звучит.
        this.misses = 0
        if (this.waiting === w) this.waiting = null
        w.reject(
          new WindowSilentError(
            'окно программы не отвечает, звук не проигрывается. Закройте программу и откройте снова'
          )
        )
        return
      }
      this.onWarn(NO_ANSWER)
      this.settle(w.id, 'ended')
    }, w.leftMs)
  }

  /** Сигнал из окна: доиграло или остановлено. */
  finish(id: number, result: 'ended' | 'stopped'): void {
    this.misses = 0
    this.settle(id, result)
  }

  /** Окно перезапущено после сбоя: звук, который в нём играл, оборван. */
  windowLost(): void {
    if (this.waiting) this.settle(this.waiting.id, 'stopped')
  }

  private settle(id: number, result: 'ended' | 'stopped'): void {
    const w = this.waiting
    if (!w || w.id !== id) return
    if (w.timer) clearTimeout(w.timer)
    this.waiting = null
    w.resolve(result)
  }

  stop(fadeMs: number): void {
    const w = this.waiting
    if (!w) return
    this.bridge.send('stop', { id: w.id, fadeMs })
    // На паузе звук в окне заморожен и сигнал "остановлено" не придёт: завершаем сами,
    // иначе пропуск, очистка и удаление модератором не работали бы до "Продолжить".
    if (this.paused) this.settle(w.id, 'stopped')
  }

  pause(): void {
    this.paused = true
    // Пока стоит пауза, страховочный таймер не должен сработать: запоминаем остаток.
    const w = this.waiting
    if (w?.timer) {
      clearTimeout(w.timer)
      w.timer = null
      w.leftMs = Math.max(1000, w.deadline - Date.now())
    }
    this.bridge.send('pause', null)
  }

  resume(): void {
    this.paused = false
    if (this.waiting && !this.waiting.timer) this.arm()
    this.bridge.send('resume', null)
  }

  setVolume(volume: number): void {
    this.bridge.send('volume', { volume })
  }
}
