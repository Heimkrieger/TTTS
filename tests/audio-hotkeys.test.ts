import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accelerator, keyName, pickDevice } from '../src/shared/audio'
import { Hotkeys, type ShortcutApi } from '../src/main/hotkeys'
import { TtsQueue, type Player } from '../src/main/queue/queue'
import type { ChatMessage } from '../src/shared/types'

describe('выбор устройства вывода', () => {
  const devs = [
    { deviceId: 'a1', label: 'CABLE Input (VB-Audio Virtual Cable)' },
    { deviceId: 'b2', label: 'Динамики (Realtek Audio)' }
  ]
  it('по умолчанию', () => {
    expect(pickDevice(devs, '', '')).toEqual({
      deviceId: '',
      label: 'как в Windows (по умолчанию)'
    })
  })
  it('по id', () => {
    expect(pickDevice(devs, 'b2', 'что угодно')?.deviceId).toBe('b2')
  })
  it('id сменился (разработка / собранная программа) - находим по имени', () => {
    expect(pickDevice(devs, 'старый-id', 'CABLE Input (VB-Audio Virtual Cable)')?.deviceId).toBe(
      'a1'
    )
  })
  it('устройство отключено - null (звук пойдёт в устройство по умолчанию с предупреждением)', () => {
    expect(pickDevice(devs, 'x', 'Наушники Bluetooth')).toBeNull()
  })
})

describe('сочетания клавиш', () => {
  const ev = (
    code: string,
    m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}
  ) => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...m
  })
  it('с модификаторами', () => {
    expect(accelerator(ev('KeyS', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+S')
    expect(accelerator(ev('Digit1', { shiftKey: true }))).toBe('Shift+1')
  })
  it('F-клавиши и цифровой блок можно без модификатора, обычные буквы - нельзя', () => {
    expect(accelerator(ev('F9'))).toBe('F9')
    expect(accelerator(ev('Numpad5'))).toBe('num5')
    expect(accelerator(ev('KeyS'))).toBeNull()
  })
  it('только модификатор - не сочетание', () => {
    expect(accelerator(ev('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(keyName('ShiftLeft')).toBeNull()
  })
})

describe('горячие клавиши', () => {
  function api(taken: string[] = []): ShortcutApi & { registered: string[] } {
    const registered: string[] = []
    return {
      registered,
      register(acc) {
        if (acc === 'плохое') throw new Error('bad accelerator')
        if (taken.includes(acc)) return false
        registered.push(acc)
        return true
      },
      unregisterAll() {
        registered.length = 0
      }
    }
  }
  const noop = { skip: () => {}, pause: () => {}, toggle: () => {} }

  it('регистрирует все три', () => {
    const a = api()
    const h = new Hotkeys(a, noop)
    h.apply({ skip: 'Ctrl+Alt+S', pause: 'Ctrl+Alt+P', toggle: 'Ctrl+Alt+T' })
    expect(a.registered).toEqual(['Ctrl+Alt+S', 'Ctrl+Alt+P', 'Ctrl+Alt+T'])
    expect(h.status.every((s) => s.ok)).toBe(true)
  })

  it('занято другой программой, неправильное, повтор, выключено - каждое со своей причиной', () => {
    const h = new Hotkeys(api(['F9']), noop)
    h.apply({ skip: 'F9', pause: 'плохое', toggle: '' })
    expect(h.status.map((s) => [s.action, s.ok, s.error])).toEqual([
      ['skip', false, 'сочетание занято другой программой, выберите другое'],
      [
        'pause',
        false,
        'Windows не принимает такое сочетание, выберите другое, например Ctrl+Shift+буква'
      ],
      ['toggle', true, null]
    ])
    h.apply({ skip: 'F10', pause: 'f10', toggle: '' })
    expect(h.status[1]?.error).toBe('уже назначено на "Пропустить текущее"')
  })

  it('без изменений настройки повторно не перерегистрирует', () => {
    const h = new Hotkeys(api(), noop)
    const cfg = { skip: 'F9', pause: '', toggle: '' }
    expect(h.apply(cfg)).toBe(true)
    expect(h.apply({ ...cfg })).toBe(false)
  })
})

describe('20 сообщений подряд', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('играют по одному, без наложений и пропусков', async () => {
    let playing = 0
    let maxPlaying = 0
    const order: string[] = []
    const player: Player = {
      play: (it) =>
        new Promise((resolve) => {
          playing++
          maxPlaying = Math.max(maxPlaying, playing)
          order.push(it.audio?.toString() ?? '')
          setTimeout(() => {
            playing--
            resolve('ended')
          }, 1000)
        }),
      stop: () => {},
      pause: () => {},
      resume: () => {}
    }
    const q = new TtsQueue(
      {
        synthesize: (text) =>
          new Promise((r) => setTimeout(() => r({ audio: Buffer.from(text), durationSec: 1 }), 700))
      },
      player,
      () => ({ speed: 1, volume: 100, pauseBetweenMs: 300, maxDurationSec: 45, overLimit: 'skip' }),
      false
    )
    const msg = (i: number): ChatMessage => ({
      id: `m${i}`,
      user: 'u',
      displayName: 'u',
      text: `${i}`,
      badges: [],
      color: null,
      emotes: [],
      subMonths: null,
      reply: null,
      rewardId: null,
      isAction: false,
      timestamp: 0
    })
    for (let i = 1; i <= 20; i++) q.enqueue(msg(i), `сообщение ${i}`)
    await vi.advanceTimersByTimeAsync(60_000)
    q.stop()
    expect(maxPlaying).toBe(1)
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => `сообщение ${i + 1}`))
    expect(q.snapshot().history.filter((h) => h.status === 'done')).toHaveLength(20)
  })
})
