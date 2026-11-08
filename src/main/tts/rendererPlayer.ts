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

let seq = 0

export class RendererPlayer implements Player {
  private waiting: {
    id: number
    resolve: (r: 'ended' | 'stopped') => void
    timer: ReturnType<typeof setTimeout> | null
    /** Когда сработает страховка (мс) и сколько оставалось на момент паузы. */
    deadline: number
    leftMs: number
  } | null = null
  private paused = false

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
      this.waiting = { id, resolve, timer: null, deadline: 0, leftMs: limit }
      this.arm()
    })
  }

  private arm(): void {
    const w = this.waiting
    if (!w) return
    w.deadline = Date.now() + w.leftMs
    w.timer = setTimeout(() => {
      this.onWarn(NO_ANSWER)
      this.finish(w.id, 'ended')
    }, w.leftMs)
  }

  /** Сигнал из окна: доиграло или остановлено. */
  finish(id: number, result: 'ended' | 'stopped'): void {
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
    if (this.paused) this.finish(w.id, 'stopped')
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
