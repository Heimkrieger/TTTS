import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FishClient,
  FishError,
  FishFatalError,
  parseVoiceId,
  type FishSynthParams
} from '../src/main/tts/fish'
import { mp3Duration } from '../src/main/tts/mp3'
import { AudioCache } from '../src/main/tts/cache'
import { FishProvider } from '../src/main/tts/provider'
import { DailyBudget, decideModel } from '../src/main/tts/budget'
import { processTags, type TagSettings } from '../src/main/tts/tags'
import { SETTINGS_VERSION, settingsSchema, type Settings } from '../src/shared/settings'

// Настоящий ответ Fish (s2.1-pro-free): 44720 байт, mp3 128 кбит/с.
const SAMPLE = readFileSync(join(__dirname, 'fixtures', 'fish-sample.mp3'))

const P: FishSynthParams = {
  text: 'привет',
  model: 's2.1-pro-free',
  voiceId: 'abc',
  temperature: 0.7,
  topP: 0.7,
  speed: 1
}

type Call = { url: string; init: RequestInit }
function fakeFetch(responses: (Response | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses.shift()
    if (!r) throw new Error('нет ответа')
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
  return { fetch: f, calls }
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mp3 = (): Response =>
  new Response(SAMPLE, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
const noSleep = async (): Promise<void> => {}

describe('длительность mp3', () => {
  it('настоящий ответ Fish: около 2.8 с (44720 байт * 8 / 128 кбит/с)', () => {
    const d = mp3Duration(SAMPLE)
    expect(d).not.toBeNull()
    expect(d!).toBeGreaterThan(2.5)
    expect(d!).toBeLessThan(3.0)
  })
  it('не mp3 - null', () => {
    expect(mp3Duration(Buffer.from('{"status":401}'))).toBeNull()
  })
})

describe('клиент Fish', () => {
  it('запрос по спецификации: адрес, ключ, модель в заголовке, поля тела', async () => {
    const { fetch, calls } = fakeFetch([mp3()])
    const c = new FishClient(() => 'KEY', fetch, noSleep)
    const r = await c.synthesize(P)
    expect(r.audio.length).toBe(SAMPLE.length)
    expect(calls[0]?.url).toBe('https://api.fish.audio/v1/tts')
    const h = calls[0]?.init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer KEY')
    expect(h.model).toBe('s2.1-pro-free')
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      text: 'привет',
      reference_id: 'abc',
      format: 'mp3',
      temperature: 0.7,
      top_p: 0.7,
      prosody: { speed: 1, volume: 0 }
    })
  })

  it('401 - неверный ключ, без повторов, фатально', async () => {
    const { fetch, calls } = fakeFetch([json(401, { status: 401, message: 'Invalid Token' })])
    const e = await new FishClient(() => 'K', fetch, noSleep).synthesize(P).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(FishFatalError)
    expect((e as Error).message).toContain('Ключ Fish Audio неверный')
    expect(calls).toHaveLength(1)
  })

  it('402 на платной модели - понятный текст про кредиты и бесплатную модель', async () => {
    const { fetch } = fakeFetch([json(402, { message: 'Insufficient API credit' })])
    const e = await new FishClient(() => 'K', fetch, noSleep)
      .synthesize({ ...P, model: 's2.1-pro' })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(FishFatalError)
    expect((e as Error).message).toContain('s2.1-pro-free')
  })

  it('429 и 503 - 2 повтора, потом успех', async () => {
    const { fetch, calls } = fakeFetch([json(429, {}), json(503, {}), mp3()])
    const r = await new FishClient(() => 'K', fetch, noSleep).synthesize(P)
    expect(r.audio.length).toBe(SAMPLE.length)
    expect(calls).toHaveLength(3)
  })

  it('нет сети 3 раза - ошибка с понятным текстом (не фатальная)', async () => {
    const { fetch } = fakeFetch([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed')
    ])
    const e = await new FishClient(() => 'K', fetch, noSleep).synthesize(P).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(FishError)
    expect((e as Error).message).toContain(
      'нет связи с Fish Audio, 3 попытки не помогли. Проверьте интернет'
    )
  })

  it('нет ключа - фатально, без запроса', async () => {
    const { fetch, calls } = fakeFetch([])
    const e = await new FishClient(() => null, fetch, noSleep)
      .synthesize(P)
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(FishFatalError)
    expect(calls).toHaveLength(0)
  })

  it('баланс и поиск голосов', async () => {
    const { fetch, calls } = fakeFetch([
      json(200, { credit: '1.25' }),
      json(200, {
        items: [
          {
            _id: 'v1',
            title: 'Голос',
            languages: ['ru'],
            author: { nickname: 'автор' },
            task_count: 5
          }
        ]
      })
    ])
    const c = new FishClient(() => 'K', fetch, noSleep)
    expect(await c.balance()).toBe('1.25')
    expect(await c.searchVoices('кот', 'ru')).toEqual([
      { id: 'v1', title: 'Голос', languages: ['ru'], author: 'автор', uses: 5 }
    ])
    expect(calls[0]?.url).toBe('https://api.fish.audio/wallet/self/api-credit')
    expect(calls[1]?.url).toContain('title=%D0%BA%D0%BE%D1%82')
    expect(calls[1]?.url).toContain('language=ru')
  })

  it('id голоса из ссылки', () => {
    expect(parseVoiceId('https://fish.audio/m/2a1036d645634680b3cc69aeeb60375b/')).toBe(
      '2a1036d645634680b3cc69aeeb60375b'
    )
    expect(parseVoiceId('2A1036D645634680B3CC69AEEB60375B')).toBe(
      '2a1036d645634680b3cc69aeeb60375b'
    )
    expect(parseVoiceId('просто текст')).toBeNull()
  })
})

describe('кэш и счёт расходов', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tts-cache-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('повтор той же фразы берётся из кэша без запроса; другой голос - новый запрос', async () => {
    const settings: Settings = settingsSchema.parse({ version: SETTINGS_VERSION })
    settings.tts.voiceId = 'v1'
    const { fetch, calls } = fakeFetch([mp3(), mp3()])
    const p = new FishProvider(
      new FishClient(() => 'K', fetch, noSleep),
      new AudioCache(dir),
      () => settings
    )
    const signal = new AbortController().signal
    await p.synthesize('привет чат', { speed: 1, signal })
    const again = await p.synthesize('привет чат', { speed: 1, signal })
    expect(again.audio!.length).toBe(SAMPLE.length)
    expect(calls).toHaveLength(1)
    settings.tts.voiceId = 'v2'
    await p.synthesize('привет чат', { speed: 1, signal })
    expect(calls).toHaveLength(2)
    // Кириллица: "привет чат" = 9 букв * 2 + пробел = 19 байт на запрос.
    expect(p.stats).toEqual({ requests: 2, cacheHits: 1, bytes: 38, costUsd: 0 })
  })

  it('платная модель: стоимость по байтам', async () => {
    const settings: Settings = settingsSchema.parse({ version: SETTINGS_VERSION })
    settings.tts.model = 's2.1-pro'
    const { fetch } = fakeFetch([mp3()])
    const p = new FishProvider(
      new FishClient(() => 'K', fetch, noSleep),
      new AudioCache(dir),
      () => settings
    )
    await p.synthesize('a'.repeat(1000), { speed: 1, signal: new AbortController().signal })
    expect(p.stats.costUsd).toBeCloseTo(0.015, 6) // 1000 байт * $15 / 1 млн
  })

  it('дневной лимит: после исчерпания - бесплатная модель или пауза, в полночь сброс', async () => {
    const settings: Settings = settingsSchema.parse({ version: SETTINGS_VERSION })
    settings.tts.model = 's2.1-pro'
    settings.tts.budget = { dailyUsd: 0.01, onLimit: 'free' }
    let now = new Date(2026, 10, 9, 23, 0).getTime()
    const budgetFile = join(dir, 'budget.json')
    const { fetch, calls } = fakeFetch([mp3(), mp3(), mp3()])
    const p = new FishProvider(
      new FishClient(() => 'K', fetch, noSleep),
      new AudioCache(dir),
      () => settings,
      new DailyBudget(budgetFile, () => now)
    )
    const limits: string[] = []
    p.on('limit', (t) => limits.push(t))
    const signal = new AbortController().signal
    const modelOf = (i: number): unknown => (calls[i]?.init.headers as Record<string, string>).model
    await p.synthesize('a'.repeat(1000), { speed: 1, signal }) // $0.015 >= $0.01
    expect(modelOf(0)).toBe('s2.1-pro')
    expect(p.budgetStatus()).toMatchObject({ active: true, exceeded: true })
    await p.synthesize('второе', { speed: 1, signal })
    expect(modelOf(1)).toBe('s2.1-pro-free')
    expect(limits).toHaveLength(1)
    // Перезапуск программы: счётчик за день сохранился.
    expect(new DailyBudget(budgetFile, () => now).spent()).toBeCloseTo(0.015, 6)
    // Режим "пауза": ошибка с fatal, очередь встанет на паузу.
    settings.tts.budget.onLimit = 'pause'
    await expect(p.synthesize('третье', { speed: 1, signal })).rejects.toMatchObject({
      fatal: true
    })
    // Готовая запись в кэше бесплатна: пауза по лимиту её не блокирует (повтор из истории).
    await expect(p.synthesize('a'.repeat(1000), { speed: 1, signal })).resolves.toBeTruthy()
    // Полночь: лимит заново, снова платная модель.
    now = new Date(2026, 10, 10, 0, 1).getTime()
    await p.synthesize('новый день', { speed: 1, signal })
    expect(modelOf(2)).toBe('s2.1-pro')
    expect(decideModel('s2.1-pro-free', settings.tts.budget, 999)).toMatchObject({ action: 'use' })
  })

  it('Fish трижды подряд отклонил запрос, а голоса уже нет: пауза с понятной причиной', async () => {
    const settings: Settings = settingsSchema.parse({ version: SETTINGS_VERSION })
    settings.tts.voiceId = 'v1'
    const bad = (): Response => json(400, { message: 'bad' })
    const { fetch, calls } = fakeFetch([bad(), bad(), bad(), json(404, {})])
    const p = new FishProvider(
      new FishClient(() => 'K', fetch, noSleep),
      new AudioCache(dir),
      () => settings
    )
    const signal = new AbortController().signal
    const fail = (t: string): Promise<Error & { fatal?: boolean }> =>
      p.synthesize(t, { speed: 1, signal }).then(
        () => new Error('не упало'),
        (e: Error) => e
      )
    // Один и два отказа - пропускаем сообщение, очередь идёт дальше.
    expect((await fail('раз')).fatal).toBeUndefined()
    expect((await fail('два')).fatal).toBeUndefined()
    const third = await fail('три')
    expect(third.fatal).toBe(true)
    expect(third.message).toContain('больше недоступен на fish.audio')
    expect(calls.at(-1)?.url).toContain('/model/v1')
  })

  it('сбой сохранённых записей не мешает озвучке и не молчит', () => {
    const errors: string[] = []
    const key = 'a'.repeat(40)
    const c = new AudioCache(dir, undefined, undefined, (r) => errors.push(r))
    c.put(key, Buffer.alloc(10), 1)
    // Файл записи подменили папкой: чтение падает, но ответ - просто "нет записи".
    rmSync(join(dir, `${key}.mp3`))
    mkdirSync(join(dir, `${key}.mp3`))
    expect(c.get(key)).toBeNull()
    expect(errors).toHaveLength(1)
    rmSync(join(dir, `${key}.mp3`), { recursive: true })
    // Файл звука без записи в списке убирается при запуске.
    const orphan = `${'b'.repeat(40)}.mp3`
    writeFileSync(join(dir, orphan), 'x')
    new AudioCache(dir)
    expect(readdirSync(dir)).not.toContain(orphan)
  })

  it('LRU: при переполнении удаляются давно использованные', () => {
    let t = 0
    const c = new AudioCache(dir, 250, () => ++t)
    c.put('a', Buffer.alloc(100), 1)
    c.put('b', Buffer.alloc(100), 1)
    c.get('a') // a свежее, чем b
    c.put('c', Buffer.alloc(100), 1)
    expect(c.get('b')).toBeNull()
    expect(c.get('a')).not.toBeNull()
    expect(
      readdirSync(dir)
        .filter((f) => f.endsWith('.mp3'))
        .sort()
    ).toEqual(['a.mp3', 'c.mp3'])
  })
})

describe('теги', () => {
  const cfg = (p: Partial<TagSettings> = {}): TagSettings => ({
    mode: 'convert',
    allowPaired: false,
    blockedWords: [],
    ...p
  })

  it('служебные теги от зрителей вырезаются всегда', () => {
    expect(processTags('<|speaker:1|> привет <|phoneme_start|>', cfg({ mode: 'asis' }))).toBe(
      'привет'
    )
  })
  it('(x) -> [x] в режиме автоконвертации', () => {
    expect(processTags('(sighs) ну [laughing] ок', cfg())).toBe('[sighs] ну [laughing] ок')
  })
  it('как есть', () => {
    expect(processTags('(sighs) ну', cfg({ mode: 'asis' }))).toBe('(sighs) ну')
  })
  it('вырезать все теги', () => {
    expect(processTags('[gasp], привет (sighs) чат', cfg({ mode: 'strip' }))).toBe('привет чат')
  })
  it('парные теги: по умолчанию разметка вырезается, текст остаётся; можно разрешить', () => {
    expect(processTags('<whisper>тихо</whisper> громко', cfg())).toBe('тихо громко')
    expect(processTags('<whisper>тихо</whisper> громко', cfg({ allowPaired: true }))).toBe(
      '<whisper>тихо</whisper> громко'
    )
  })
  it('слова-запреты внутри тегов', () => {
    expect(processTags('[moan] [gasp] привет', cfg({ blockedWords: ['moan'] }))).toBe(
      '[gasp] привет'
    )
    expect(processTags('[moaning loudly] ок', cfg({ blockedWords: ['MOAN'] }))).toBe('ок')
  })
})
