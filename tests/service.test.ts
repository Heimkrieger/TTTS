// Связка чат -> фильтры -> очередь и действия стримера (мьют, ЧС, вручную, удаление модератором).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from '../src/main/chat/service'
import type { SocketLike } from '../src/main/chat/twitch'
import { Journal } from '../src/main/journal'
import { TtsQueue, type Player } from '../src/main/queue/queue'
import { estimateProvider } from '../src/main/queue/silent'
import { SettingsStore, type Encryptor } from '../src/main/settings'

class FakeSocket implements SocketLike {
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(d: string): void {
    this.sent.push(d)
  }
  close(): void {}
  receive(line: string): void {
    this.onmessage?.({ data: line + '\r\n' })
  }
}

/** Плеер, который никогда сам не заканчивает: удобно смотреть очередь. */
class HoldPlayer implements Player {
  stops = 0
  private res: ((r: 'ended' | 'stopped') => void) | null = null
  play(): Promise<'ended' | 'stopped'> {
    return new Promise((r) => (this.res = r))
  }
  stop(): void {
    this.stops++
    this.res?.('stopped')
    this.res = null
  }
  pause(): void {}
  resume(): void {}
}

const enc: Encryptor = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s),
  decrypt: (b) => b.toString()
}
const silent = { info: () => {}, warn: () => {}, error: () => {} }

let dir: string
let store: SettingsStore
let socket: FakeSocket
let queue: TtsQueue
let player: HoldPlayer
let svc: ChatService
let journal: Journal
let now: number
let n = 0

function say(user: string, text: string, id = `m${++n}`): string {
  socket.receive(`@id=${id};display-name=${user} :${user}!${user}@x PRIVMSG #chan :${text}`)
  return id
}
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'tts-svc-'))
  store = new SettingsStore(join(dir, 'settings.json'), enc, silent)
  store.update({ twitch: { channel: 'chan' }, filters: { userCooldownSec: 0 } })
  now = 1_800_000_000_000
  player = new HoldPlayer()
  queue = new TtsQueue(estimateProvider, player, () => store.current().tts, true)
  journal = new Journal(silent, () => now)
  svc = new ChatService(
    store,
    () => (socket = new FakeSocket()),
    async () => ({}),
    queue,
    journal,
    silent,
    () => now
  )
  svc.applySettings()
  socket.onopen?.()
  socket.receive('@room-id=1 :tmi.twitch.tv ROOMSTATE #chan')
})
afterEach(() => {
  queue.stop()
  svc.stop()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('чат -> очередь', () => {
  it('сообщение с префиксом попадает в очередь, статус в ленте меняется', async () => {
    const a = say('vasya', '!!! первое')
    const b = say('petya', '!!! второе')
    say('kolya', 'без префикса')
    await flush()
    const snap = queue.snapshot()
    expect(snap.current?.text).toBe('первое')
    expect(snap.items.map((i) => i.text)).toEqual(['второе'])
    expect(svc.feed.get(a)?.status).toBe('speaking')
    expect(svc.feed.get(b)?.status).toBe('queued')
  })

  it('модератор удалил сообщение: из очереди уходит, звучащее останавливается', async () => {
    const a = say('vasya', '!!! первое')
    say('petya', '!!! второе', 'del2')
    await flush()
    socket.receive('@target-msg-id=del2 :tmi.twitch.tv CLEARMSG #chan :второе')
    expect(queue.snapshot().items).toHaveLength(0)
    socket.receive(`@target-msg-id=${a} :tmi.twitch.tv CLEARMSG #chan :первое`)
    await flush()
    expect(player.stops).toBe(1)
    expect(svc.feed.get(a)?.status).toBe('deleted')
  })

  it('бан модератором убирает все сообщения зрителя из очереди', async () => {
    say('other', '!!! играет')
    say('vasya', '!!! раз')
    say('vasya', '!!! два')
    await flush()
    socket.receive(':tmi.twitch.tv CLEARCHAT #chan :vasya')
    expect(queue.snapshot().items).toHaveLength(0)
    expect(journal.snapshot().at(-1)?.text).toContain('vasya: бан')
  })
})

describe('действия стримера', () => {
  it('мьют на 5 минут: из очереди убран, новые не проходят, после срока - снова можно', async () => {
    say('other', '!!! играет')
    say('vasya', '!!! раз')
    await flush()
    expect(svc.mute('Vasya', 5).ok).toBe(true)
    expect(queue.snapshot().items).toHaveLength(0)
    const b = say('vasya', '!!! ещё')
    expect(svc.feed.get(b)?.status).toBe('rejected')
    expect(svc.feed.get(b)?.reason).toMatch(/^мьют до \d\d:\d\d$/)
    expect(journal.snapshot().at(-1)?.text).toContain('vasya: мьют на 5 мин')
    now += 5 * 60_000 + 1
    const c = say('vasya', '!!! снова')
    expect(svc.feed.get(c)?.status).toBe('queued')
  })

  it('размьют', () => {
    svc.mute('vasya', 60)
    expect(svc.unmute('vasya').ok).toBe(true)
    expect(svc.unmute('vasya').ok).toBe(false)
    const a = say('vasya', '!!! можно')
    expect(svc.feed.get(a)?.status).not.toBe('rejected')
  })

  it('чёрный список: убирает из очереди, сохраняется в настройках, снимается', async () => {
    say('other', '!!! играет')
    say('troll', '!!! спам')
    await flush()
    svc.blacklist('troll', true)
    expect(queue.snapshot().items).toHaveLength(0)
    expect(store.current().filters.blacklist).toContain('troll')
    svc.blacklist('troll', false)
    expect(store.current().filters.blacklist).not.toContain('troll')
  })

  it('озвучить вручную: сообщение без префикса встаёт перед обычными', async () => {
    say('other', '!!! играет')
    say('a', '!!! обычное')
    const m = say('b', 'без префикса но хорошее')
    await flush()
    expect(svc.speakManually(m).ok).toBe(true)
    expect(queue.snapshot().items.map((i) => [i.text, i.source])).toEqual([
      ['без префикса но хорошее', 'manual'],
      ['обычное', 'chat']
    ])
    expect(svc.feed.get(m)?.status).toBe('queued')
  })

  it('озвучить вручную работает и в режиме "только награда"', () => {
    store.update({ filters: { trigger: 'reward' } })
    const m = say('vasya', 'просто сообщение')
    expect(svc.feed.get(m)?.status).toBe('no-prefix')
    expect(svc.speakManually(m).ok).toBe(true)
  })

  it('смена канала очищает очередь старого канала', async () => {
    say('vasya', '!!! первое')
    say('petya', '!!! второе')
    await flush()
    store.update({ twitch: { channel: 'other' } })
    svc.applySettings()
    expect(queue.snapshot().items).toHaveLength(0)
  })

  it('озвучить вручную: пустое после чистки - понятный отказ', () => {
    const m = say('b', 'https://example.com')
    const r = svc.speakManually(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Не прошло фильтры')
  })
})
