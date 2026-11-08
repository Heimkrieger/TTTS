// Проигрывание через OBS: звук уходит на страницу-источник "Браузер", страница сообщает "доиграло".
// Источник не подключён - ошибка с полем fatal: очередь встаёт на паузу, сообщение не теряется.
import type { Player } from '../queue/queue'
import type { OverlayServer } from './server'

export class ObsNotConnectedError extends Error {
  /** Очередь видит это поле и встаёт на паузу. */
  readonly fatal = true
}

let seq = 0

export class ObsPlayer implements Player {
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

  constructor(
    private readonly server: OverlayServer,
    private readonly onWarn: (text: string) => void,
    /** Технические подробности: только в файл журнала, не на экран. */
    private readonly onDetail: (text: string) => void = () => {}
  ) {
    server.on('ended', (id, result, error) => {
      if (error) {
        this.onWarn(
          'Звук в OBS не проигрался. Проверьте, что источник "Браузер" открыт и звук в нём не выключен.'
        )
        this.onDetail(`OBS: ${error}`)
      }
      this.finish(id, result)
    })
    server.on('status', (s) => {
      // Все источники отключились посреди звука: ответа не будет. Сообщение не теряем -
      // очередь вернёт его первым и встанет на паузу.
      const w = this.waiting
      if (s.clients === 0 && w) {
        if (w.timer) clearTimeout(w.timer)
        this.waiting = null
        w.reject(
          new ObsNotConnectedError(
            'источник "Браузер" в OBS отключился посреди сообщения. Сообщение не потеряно: оно прозвучит первым, когда OBS подключится и вы нажмёте "Продолжить".'
          )
        )
      }
    })
  }

  play(item: {
    audio: Buffer | null
    durationSec: number
    volume: number
    trimSec: number | null
  }): Promise<'ended' | 'stopped'> {
    if (!item.audio) return Promise.resolve('ended')
    if (this.server.clientCount === 0) {
      const s = this.server.status()
      return Promise.reject(
        new ObsNotConnectedError(
          s.error ??
            `OBS не подключён: добавьте источник "Браузер" с адресом ${s.url} (раздел "Звук")`
        )
      )
    }
    const id = ++seq
    this.paused = false
    return new Promise((resolve, reject) => {
      this.server.send({
        type: 'play',
        id,
        audio: item.audio?.toString('base64'),
        volume: item.volume,
        trimSec: item.trimSec
      })
      const limit = (Math.min(item.durationSec, item.trimSec ?? Infinity) + 10) * 1000
      this.waiting = { id, resolve, reject, timer: null, deadline: 0, leftMs: limit }
      this.arm()
    })
  }

  /** Страховка: если OBS не ответит "доиграло", через оставшееся время + 10 с идём дальше. */
  private arm(): void {
    const w = this.waiting
    if (!w) return
    w.deadline = Date.now() + w.leftMs
    w.timer = setTimeout(() => {
      this.onWarn('OBS не сообщил о конце звука, переходим к следующему сообщению')
      this.finish(w.id, 'ended')
    }, w.leftMs)
  }

  private finish(id: number, result: 'ended' | 'stopped'): void {
    const w = this.waiting
    if (!w || w.id !== id) return
    if (w.timer) clearTimeout(w.timer)
    this.waiting = null
    w.resolve(result)
  }

  stop(fadeMs: number): void {
    const w = this.waiting
    if (!w) return
    this.server.send({ type: 'stop', id: w.id, fadeMs })
    // На паузе страница может не ответить "остановлено": завершаем сами.
    if (this.paused) this.finish(w.id, 'stopped')
  }

  pause(): void {
    this.paused = true
    const w = this.waiting
    if (w?.timer) {
      clearTimeout(w.timer)
      w.timer = null
      w.leftMs = Math.max(1000, w.deadline - Date.now())
    }
    this.server.send({ type: 'pause' })
  }

  resume(): void {
    this.paused = false
    if (this.waiting && !this.waiting.timer) this.arm()
    this.server.send({ type: 'resume' })
  }

  setVolume(volume: number): void {
    this.server.send({ type: 'volume', volume })
  }
}
