import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TtsQueue,
  type Player,
  type QueueSettings,
  type SynthResult,
  type TtsProvider
} from '../src/main/queue/queue'
import type { ChatMessage } from '../src/shared/types'

const msg = (id: string, user = 'u', text = 'привет'): ChatMessage => ({
  id,
  user,
  displayName: user,
  text,
  badges: [],
  color: null,
  emotes: [],
  subMonths: null,
  reply: null,
  rewardId: null,
  isAction: false,
  timestamp: 0
})

/** Синтез, который отвечает, когда скажет тест. */
class FakeProvider implements TtsProvider {
  calls: string[] = []
  pending = new Map<string, { resolve: (r: SynthResult) => void; reject: (e: Error) => void }>()
  auto: number | null = null // если задано - сразу отвечает с такой длительностью
  synthesize(text: string, opts: { signal: AbortSignal }): Promise<SynthResult> {
    this.calls.push(text)
    if (this.auto !== null)
      return Promise.resolve({ audio: Buffer.from(text), durationSec: this.auto })
    return new Promise((resolve, reject) => {
      this.pending.set(text, { resolve, reject })
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  finish(text: string, durationSec = 2): void {
    this.pending.get(text)?.resolve({ audio: Buffer.from(text), durationSec })
    this.pending.delete(text)
  }
  fail(text: string, err: string): void {
    this.pending.get(text)?.reject(new Error(err))
    this.pending.delete(text)
  }
}

/** Плеер, который "играет", пока тест не скажет ended. */
class FakePlayer implements Player {
  playing: string[] = []
  stops = 0
  paused = false
  private resolve: ((r: 'ended' | 'stopped') => void) | null = null
  play(item: { audio: Buffer | null; trimSec: number | null }): Promise<'ended' | 'stopped'> {
    this.playing.push(item.audio?.toString() ?? '')
    this.lastTrim = item.trimSec
    return new Promise((r) => (this.resolve = r))
  }
  lastTrim: number | null = null
  end(): void {
    this.resolve?.('ended')
    this.resolve = null
  }
  stop(): void {
    this.stops++
    this.resolve?.('stopped')
    this.resolve = null
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
  }
}

let provider: FakeProvider
let player: FakePlayer
let settings: QueueSettings
let q: TtsQueue
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)

beforeEach(() => {
  vi.useFakeTimers()
  provider = new FakeProvider()
  player = new FakePlayer()
  settings = {
    speed: 1,
    volume: 100,
    pauseBetweenMs: 300,
    chatDelayMs: 0,
    maxDurationSec: 45,
    overLimit: 'skip'
  }
  q = new TtsQueue(provider, player, () => settings, false)
})
afterEach(() => {
  q.stop()
  vi.useRealTimers()
})

describe('очередь озвучки', () => {
  it('плеер не может играть (OBS не подключён): сообщения не теряются, очередь на паузе с причиной', async () => {
    provider.auto = 1
    let fail = true
    const fatalPlayer = {
      play: (item: { audio: Buffer | null }) => {
        if (fail)
          return Promise.reject(Object.assign(new Error('OBS не подключён'), { fatal: true }))
        return player.play({ audio: item.audio, trimSec: null })
      },
      stop: () => player.stop(),
      pause: () => player.pause(),
      resume: () => player.resume()
    }
    q.setBackend(provider, fatalPlayer, false)
    for (let i = 0; i < 3; i++) q.enqueue(msg(String(i)), `t${i}`)
    await flush()
    const snap = q.snapshot()
    expect(snap.paused).toBe(true)
    expect(snap.pauseReason).toBe('OBS не подключён')
    expect(snap.items.map((i) => i.text)).toEqual(['t0', 't1', 't2'])
    expect(snap.history).toHaveLength(0)
    // На паузе из-за ошибки новые сообщения в Fish не отправляются.
    const calls = provider.calls.length
    q.enqueue(msg('4'), 't3')
    await flush()
    expect(provider.calls.length).toBe(calls)
    fail = false
    q.resume()
    await flush()
    expect(player.playing.at(-1)).toBe('t0')
  })

  it('история: повтор любого сообщения; старое без аудио синтезируется заново (из кэша)', async () => {
    provider.auto = 1
    for (let i = 0; i < 7; i++) q.enqueue(msg(String(i)), `t${i}`)
    for (let i = 0; i < 7; i++) {
      await flush()
      player.end()
      await vi.advanceTimersByTimeAsync(300)
    }
    await flush()
    player.end()
    await flush()
    const hist = q.fullHistory()
    expect(hist.map((h) => h.text)).toEqual(['t6', 't5', 't4', 't3', 't2', 't1', 't0'])
    const calls = provider.calls.length
    const oldest = hist[6]
    expect(oldest && q.replay(oldest.id)).toMatchObject({
      ok: true,
      value: { text: 't0', source: 'manual' }
    })
    await flush()
    expect(provider.calls.length).toBe(calls + 1) // аудио t0 уже выгружено из памяти
    expect(player.playing.at(-1)).toBe('t0')
    expect(q.replay('нет-такого')).toMatchObject({ ok: false })
  })

  it('порядок FIFO, заранее синтезирует не больше 2, пауза между сообщениями', async () => {
    q.enqueue(msg('1'), 'a')
    q.enqueue(msg('2'), 'b')
    q.enqueue(msg('3'), 'c')
    await flush()
    expect(provider.calls).toEqual(['a', 'b']) // c ждёт: не больше 2 одновременно
    provider.finish('a')
    await flush()
    expect(player.playing).toEqual(['a'])
    expect(provider.calls).toEqual(['a', 'b', 'c']) // пока играет a, синтезируется следующее
    provider.finish('b')
    player.end()
    await flush()
    expect(player.playing).toEqual(['a']) // пауза 300 мс
    await vi.advanceTimersByTimeAsync(300)
    expect(player.playing).toEqual(['a', 'b'])
    expect(q.snapshot().history[0]?.status).toBe('done')
  })

  it('приоритет: награда/вручную встаёт перед обычным чатом, но после равных', async () => {
    provider.auto = 1
    q.pause()
    q.enqueue(msg('1'), 'chat1')
    q.enqueue(msg('2'), 'chat2')
    q.enqueue(msg('3'), 'manual', { priority: 5, source: 'manual' })
    q.enqueue(msg('4'), 'reward', { priority: 5, source: 'reward' })
    expect(q.snapshot().items.map((i) => i.text)).toEqual(['manual', 'reward', 'chat1', 'chat2'])
  })

  it('пропуск текущего: остановка с причиной, следующее играет', async () => {
    provider.auto = 2
    q.enqueue(msg('1'), 'a')
    q.enqueue(msg('2'), 'b')
    await flush()
    expect(player.playing).toEqual(['a'])
    q.skipCurrent()
    await flush()
    expect(q.snapshot().history[0]).toMatchObject({
      text: 'a',
      status: 'skipped',
      reason: 'пропущено вручную'
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(player.playing).toEqual(['a', 'b'])
  })

  it('удалить из середины очереди, поднять в начало', async () => {
    q.pause()
    const a = q.enqueue(msg('1'), 'a')
    q.enqueue(msg('2'), 'b')
    const c = q.enqueue(msg('3'), 'c')
    q.moveToTop(c.id)
    expect(q.snapshot().items.map((i) => i.text)).toEqual(['c', 'a', 'b'])
    q.remove(a.id)
    expect(q.snapshot().items.map((i) => i.text)).toEqual(['c', 'b'])
    expect(q.snapshot().history[0]).toMatchObject({ text: 'a', status: 'skipped' })
  })

  it('модератор удалил сообщение: из очереди уходит, звучащее останавливается', async () => {
    provider.auto = 2
    q.enqueue(msg('m1'), 'a')
    q.enqueue(msg('m2'), 'b')
    await flush()
    q.removeByMessageId('m2', 'удалено модератором')
    expect(q.snapshot().items).toHaveLength(0)
    q.removeByMessageId('m1', 'удалено модератором')
    await flush()
    expect(player.stops).toBe(1)
    expect(q.snapshot().history.map((h) => h.reason)).toEqual([
      'удалено модератором',
      'удалено модератором'
    ])
  })

  it('задержка перед озвучкой: удалённое за это время не звучит вовсе, синтез идёт заранее', async () => {
    settings.chatDelayMs = 2000
    provider.auto = 2
    q.enqueue(msg('m1'), 'a')
    q.enqueue(msg('m2'), 'b')
    await flush()
    expect(provider.calls).toEqual(['a', 'b']) // синтез уже идёт
    await vi.advanceTimersByTimeAsync(1500)
    expect(player.playing).toEqual([]) // ещё ждём
    q.removeByMessageId('m1', 'удалено модератором') // бот удалил на 1.5 с
    await vi.advanceTimersByTimeAsync(500)
    expect(player.playing).toEqual(['b'])
    expect(q.fullHistory()[0]).toMatchObject({ text: 'a', reason: 'удалено модератором' })
  })

  it('задержка не касается повтора: своё звучит сразу', async () => {
    provider.auto = 1
    q.enqueue(msg('m1'), 'a')
    await flush()
    player.end()
    await vi.advanceTimersByTimeAsync(300)
    settings.chatDelayMs = 5000
    expect(q.replayLast().ok).toBe(true)
    await flush()
    expect(player.playing).toEqual(['a', 'a'])
  })

  it('удалённое модератором нельзя повторить из истории, причина понятна', async () => {
    provider.auto = 3
    q.enqueue(msg('m1', 'vasya'), 'a')
    await flush()
    player.end()
    await vi.advanceTimersByTimeAsync(300)
    q.enqueue(msg('m2', 'petya'), 'b')
    await flush()
    player.end()
    await vi.advanceTimersByTimeAsync(300)
    q.enqueue(msg('m3', 'kolya'), 'c')
    await flush()
    player.end()
    await vi.advanceTimersByTimeAsync(300)
    const [c, b, a] = q.fullHistory()
    // Модератор удалил уже прозвучавшее сообщение.
    q.removeByMessageId('m3', 'удалено модератором')
    const r = q.replayLast()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('удалено модератором')
    // Бан: сообщения зрителя повторить нельзя. Мьют в программе - можно.
    q.removeByUser('vasya', 'бан от модератора', true)
    q.removeByUser('petya', 'мьют')
    expect(a && q.replay(a.id).ok).toBe(false)
    expect(b && q.replay(b.id).ok).toBe(true)
    // Модератор очистил чат: ничего из прежнего не повторяется.
    await flush()
    player.end()
    await vi.advanceTimersByTimeAsync(300)
    q.clearChat('чат очищен модератором')
    expect(c && q.replay(c.id).ok).toBe(false)
    expect(b && q.replay(b.id).ok).toBe(false)
  })

  it('мьют/бан зрителя убирает все его сообщения', async () => {
    q.pause()
    q.enqueue(msg('1', 'vasya'), 'a')
    q.enqueue(msg('2', 'petya'), 'b')
    q.enqueue(msg('3', 'vasya'), 'c')
    expect(q.removeByUser('vasya', 'мьют')).toBe(2)
    expect(q.snapshot().items.map((i) => i.text)).toEqual(['b'])
  })

  it('лимит длительности: оценка до синтеза не тратит запрос', () => {
    settings.maxDurationSec = 5
    const long = 'х'.repeat(5 * 14 + 20) // примерно 6.4 с
    const v = q.enqueue(msg('1'), long)
    expect(v.status).toBe('skipped')
    expect(v.reason).toContain('длиннее лимита: примерно')
    expect(provider.calls).toHaveLength(0)
  })

  it('лимит после синтеза: пропустить или обрезать', async () => {
    settings.maxDurationSec = 10
    q.enqueue(msg('1'), 'a')
    await flush()
    provider.finish('a', 30)
    await flush()
    expect(q.snapshot().history[0]).toMatchObject({ status: 'skipped' })
    expect(q.snapshot().history[0]?.reason).toContain('длиннее лимита: 30 с')
    settings.overLimit = 'trim'
    q.enqueue(msg('2'), 'b')
    await flush()
    provider.finish('b', 30)
    await flush()
    expect(player.lastTrim).toBe(10)
  })

  it('ошибка синтеза: failed с текстом, очередь идёт дальше', async () => {
    const journal: string[] = []
    q.on('journal', (_l, t) => journal.push(t))
    q.enqueue(msg('1'), 'a')
    q.enqueue(msg('2'), 'b')
    await flush()
    provider.fail('a', 'закончились кредиты')
    provider.finish('b')
    await flush()
    expect(q.snapshot().history[0]).toMatchObject({
      text: 'a',
      status: 'failed',
      reason: 'закончились кредиты'
    })
    expect(journal[0]).toContain('закончились кредиты')
    expect(player.playing).toEqual(['b'])
  })

  it('пауза и продолжение', async () => {
    provider.auto = 2
    q.enqueue(msg('1'), 'a')
    await flush()
    q.pause()
    expect(player.paused).toBe(true)
    expect(q.snapshot().paused).toBe(true)
    q.resume()
    expect(player.paused).toBe(false)
  })

  it('очистить и повторить последнее', async () => {
    provider.auto = 2
    q.enqueue(msg('1'), 'a')
    await flush()
    player.end()
    await flush()
    q.enqueue(msg('2'), 'b')
    q.enqueue(msg('3'), 'c')
    expect(q.clear()).toBe(2)
    expect(q.snapshot().items).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    q.replayLast()
    await flush()
    expect(player.playing).toEqual(['a', 'a'])
    expect(provider.calls.filter((c) => c === 'a')).toHaveLength(1) // без нового запроса
  })
})
