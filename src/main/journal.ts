// Журнал действий под очередью: кто замьючен, что пропущено, какие ошибки.
// Всё, что попадает сюда, пишется и в лог-файл.
import { EventEmitter } from 'node:events'
import type { JournalEntry } from '@shared/types'

export const JOURNAL_SIZE = 100

export class Journal extends EventEmitter<{ entry: [JournalEntry] }> {
  private entries: JournalEntry[] = []
  private seq = 0

  constructor(
    private readonly log: {
      info(...a: unknown[]): void
      warn(...a: unknown[]): void
      error(...a: unknown[]): void
    },
    private readonly now: () => number = Date.now
  ) {
    super()
  }

  add(level: JournalEntry['level'], text: string): void {
    const e: JournalEntry = { id: ++this.seq, at: this.now(), level, text }
    this.entries.push(e)
    if (this.entries.length > JOURNAL_SIZE) this.entries.shift()
    this.log[level](`journal: ${text}`)
    this.emit('entry', e)
  }

  snapshot(): JournalEntry[] {
    return [...this.entries]
  }
}
