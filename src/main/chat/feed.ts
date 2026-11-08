// Лента "Весь чат": последние N сообщений со статусом (кольцевой буфер).
import type { ChatMessage, FeedEntry, FeedStatus } from '@shared/types'

export const FEED_SIZE = 200

export class ChatFeed {
  private entries: FeedEntry[] = []

  constructor(private readonly size = FEED_SIZE) {}

  add(
    message: ChatMessage,
    status: FeedStatus,
    reason: string | null,
    finalText: string | null
  ): FeedEntry {
    const entry: FeedEntry = { message, status, reason, finalText }
    this.entries.push(entry)
    if (this.entries.length > this.size) this.entries.splice(0, this.entries.length - this.size)
    return entry
  }

  get(messageId: string): FeedEntry | null {
    return this.entries.find((x) => x.message.id === messageId) ?? null
  }

  /** Сменить статус записи (например, по событию очереди). */
  setStatus(
    messageId: string,
    status: FeedStatus,
    reason: string | null,
    finalText?: string
  ): FeedEntry | null {
    const e = this.get(messageId)
    if (!e || e.status === 'deleted') return null
    e.status = status
    e.reason = reason
    if (finalText !== undefined) e.finalText = finalText
    return e
  }

  /** Модератор удалил сообщение. Возвращает изменённую запись или null. */
  markDeleted(messageId: string): FeedEntry | null {
    const e = this.entries.find((x) => x.message.id === messageId)
    if (!e) return null
    e.status = 'deleted'
    e.reason = 'удалено модератором'
    return e
  }

  /** Таймаут или бан: помечаем все сообщения пользователя. */
  markUserCleared(login: string, reason: string): FeedEntry[] {
    const changed: FeedEntry[] = []
    for (const e of this.entries) {
      if (e.message.user === login && e.status !== 'deleted') {
        e.status = 'deleted'
        e.reason = reason
        changed.push(e)
      }
    }
    return changed
  }

  markAllCleared(): FeedEntry[] {
    const changed: FeedEntry[] = []
    for (const e of this.entries) {
      if (e.status !== 'deleted') {
        e.status = 'deleted'
        e.reason = 'чат очищен модератором'
        changed.push(e)
      }
    }
    return changed
  }

  clear(): void {
    this.entries = []
  }

  snapshot(): FeedEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }
}
