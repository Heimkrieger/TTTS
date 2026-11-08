import { describe, expect, it } from 'vitest'
import { NotFoundError, ThirdPartyEmotes, type FetchJson } from '../src/main/chat/emotes'
import type { EmoteProviderStatus } from '../src/shared/types'

// Ответы в форме настоящих API (сокращённо).
const RESPONSES: Record<string, unknown> = {
  'https://7tv.io/v3/emote-sets/global': { emotes: [{ name: 'RainTime' }, { name: 'EZ' }] },
  'https://7tv.io/v3/users/twitch/1337': { emote_set: { emotes: [{ name: 'KEKW' }] } },
  'https://api.betterttv.net/3/cached/emotes/global': [{ code: 'monkaS' }],
  'https://api.betterttv.net/3/cached/users/twitch/1337': {
    channelEmotes: [{ code: 'catJAM' }],
    sharedEmotes: [{ code: 'pepeD' }]
  },
  'https://api.frankerfacez.com/v1/set/global': {
    default_sets: [3],
    sets: { '3': { emoticons: [{ name: 'LilZ' }] }, '9': { emoticons: [{ name: 'Hidden' }] } }
  },
  'https://api.frankerfacez.com/v1/room/id/1337': {
    sets: { '5': { emoticons: [{ name: 'OMEGALUL' }] } }
  }
}

const fakeFetch =
  (fail: string[] = [], notFound: string[] = []): FetchJson =>
  async (url) => {
    if (fail.some((f) => url.includes(f))) throw new Error('fetch failed')
    if (notFound.some((f) => url.includes(f))) throw new NotFoundError('нет')
    if (!(url in RESPONSES)) throw new Error('unexpected ' + url)
    return RESPONSES[url]
  }

describe('сторонние эмоуты', () => {
  it('загружает глобальные и канала у всех трёх сервисов', async () => {
    let status: EmoteProviderStatus[] = []
    const e = new ThirdPartyEmotes(fakeFetch(), (s) => (status = s))
    await e.setRoom('1337')
    e.stop()
    for (const w of ['RainTime', 'EZ', 'KEKW', 'monkaS', 'catJAM', 'pepeD', 'LilZ', 'OMEGALUL']) {
      expect(e.has(w), w).toBe(true)
    }
    expect(e.has('Hidden')).toBe(false) // FFZ: только default_sets
    expect(e.has('kekw')).toBe(false) // регистр важен
    expect(status.map((s) => `${s.provider}:${s.state}:${s.count}`)).toEqual([
      '7TV:ok:3',
      'BTTV:ok:3',
      'FFZ:ok:2'
    ])
  })

  it('у канала нет эмоутов сервиса (404) - не ошибка', async () => {
    let status: EmoteProviderStatus[] = []
    const e = new ThirdPartyEmotes(fakeFetch([], ['7tv.io/v3/users']), (s) => (status = s))
    await e.setRoom('1337')
    e.stop()
    expect(status[0]).toEqual({ provider: '7TV', state: 'ok', count: 2, error: null })
  })

  it('сервис недоступен - видимая ошибка, остальные работают', async () => {
    let status: EmoteProviderStatus[] = []
    const e = new ThirdPartyEmotes(fakeFetch(['betterttv']), (s) => (status = s))
    await e.setRoom('1337')
    e.stop()
    expect(status[1]?.state).toBe('error')
    expect(status[1]?.error).toContain('нет связи с сервисом')
    expect(e.has('KEKW')).toBe(true)
  })

  it('при сбое обновления остаётся прошлый список', async () => {
    let failing = false
    const fetchJson: FetchJson = async (url) => {
      if (failing) throw new Error('fetch failed')
      return fakeFetch()(url)
    }
    const e = new ThirdPartyEmotes(fetchJson, () => {})
    await e.setRoom('1337')
    failing = true
    await e.load()
    e.stop()
    expect(e.has('KEKW')).toBe(true)
  })
})
