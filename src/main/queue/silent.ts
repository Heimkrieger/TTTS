// Беззвучный режим, пока нет ключа Fish: очередь и всё управление работают,
// длительность сообщения считается примерно по длине текста.
import { CHARS_PER_SEC, type Player, type TtsProvider } from './queue'

/** "Синтез" без звука: только оценка длительности. */
export const estimateProvider: TtsProvider = {
  async synthesize(text, { speed }) {
    return { audio: null, durationSec: Math.max(1, text.length / CHARS_PER_SEC / speed) }
  }
}

/** "Проигрывание" без звука: просто ждёт длительность, поддерживает паузу и стоп. */
export class SilentPlayer implements Player {
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolve: ((r: 'ended' | 'stopped') => void) | null = null
  private leftMs = 0
  private startedAt = 0

  play(item: { durationSec: number; trimSec: number | null }): Promise<'ended' | 'stopped'> {
    this.leftMs = Math.min(item.durationSec, item.trimSec ?? Infinity) * 1000
    return new Promise((resolve) => {
      this.resolve = resolve
      this.start()
    })
  }

  private start(): void {
    this.startedAt = Date.now()
    this.timer = setTimeout(() => this.done('ended'), this.leftMs)
  }

  private done(r: 'ended' | 'stopped'): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const res = this.resolve
    this.resolve = null
    res?.(r)
  }

  stop(): void {
    this.done('stopped')
  }

  pause(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.leftMs -= Date.now() - this.startedAt
  }

  resume(): void {
    if (this.resolve && !this.timer) this.start()
  }
}
