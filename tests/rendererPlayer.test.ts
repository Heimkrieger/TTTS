import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MISSES_TO_PAUSE, RendererPlayer } from '../src/main/tts/rendererPlayer'

const item = { audio: Buffer.from('x'), durationSec: 2, volume: 100, trimSec: null }

describe('звук в окне программы', () => {
  let sent: { channel: string; payload: unknown }[]
  let warns: string[]
  let player: RendererPlayer

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    warns = []
    player = new RendererPlayer(
      {
        send: (channel, payload) => {
          sent.push({ channel, payload })
          return true
        }
      },
      (t) => warns.push(t)
    )
  })
  afterEach(() => vi.useRealTimers())

  const playId = (): number => (sent.at(-1)?.payload as { id: number }).id

  it('окно ответило - сообщение доиграло', async () => {
    const p = player.play(item)
    player.finish(playId(), 'ended')
    await expect(p).resolves.toBe('ended')
    expect(warns).toHaveLength(0)
  })

  it('окно не ответило один раз - идём дальше с предупреждением', async () => {
    const p = player.play(item)
    await vi.advanceTimersByTimeAsync(12_000)
    await expect(p).resolves.toBe('ended')
    expect(warns).toHaveLength(1)
  })

  it('окно не отвечает подряд - пауза с причиной, а не "прозвучало"', async () => {
    expect(MISSES_TO_PAUSE).toBe(2)
    const first = player.play(item)
    await vi.advanceTimersByTimeAsync(12_000)
    await first
    const second = player.play(item).then(
      () => null,
      (e: Error & { fatal?: boolean }) => e
    )
    await vi.advanceTimersByTimeAsync(12_000)
    const err = await second
    expect(err?.fatal).toBe(true)
    expect(err?.message).toContain('окно программы не отвечает')
    // Ответ окна сбрасывает счётчик: следующее сообщение снова получает одну попытку.
    const third = player.play(item)
    player.finish(playId(), 'ended')
    await expect(third).resolves.toBe('ended')
  })

  it('окно перезапущено после сбоя - текущий звук считается оборванным', async () => {
    const p = player.play(item)
    player.windowLost()
    await expect(p).resolves.toBe('stopped')
  })
})
