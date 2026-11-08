// Сторонние эмоуты (7TV, BTTV, FFZ). Twitch о них ничего не сообщает: в чате это обычные слова
// вроде KEKW или OMEGALUL, и без этого списка TTS читал бы их вслух.
import type { EmoteProviderStatus } from '@shared/types'

export type FetchJson = (url: string) => Promise<unknown>

/** Обновлять списки раз в 10 минут: стример может добавить эмоут во время стрима. */
export const EMOTES_REFRESH_MS = 10 * 60_000

type Provider = EmoteProviderStatus['provider']

interface ProviderDef {
  provider: Provider
  /** Глобальные эмоуты (есть у всех каналов). */
  globalUrl: string
  channelUrl: (roomId: string) => string
  parseGlobal: (j: unknown) => string[]
  parseChannel: (j: unknown) => string[]
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const names = (list: unknown, field: string): string[] =>
  arr(list)
    .map((e) => obj(e)[field])
    .filter((n): n is string => typeof n === 'string' && n !== '')

/** FFZ: { sets: { "id": { emoticons: [{ name }] } } }. */
const ffzSets = (j: unknown, only?: number[]): string[] => {
  const sets = obj(obj(j)['sets'])
  return Object.entries(sets)
    .filter(([id]) => !only || only.includes(Number(id)))
    .flatMap(([, s]) => names(obj(s)['emoticons'], 'name'))
}

export const PROVIDERS: ProviderDef[] = [
  {
    provider: '7TV',
    globalUrl: 'https://7tv.io/v3/emote-sets/global',
    channelUrl: (id) => `https://7tv.io/v3/users/twitch/${id}`,
    parseGlobal: (j) => names(obj(j)['emotes'], 'name'),
    parseChannel: (j) => names(obj(obj(j)['emote_set'])['emotes'], 'name')
  },
  {
    provider: 'BTTV',
    globalUrl: 'https://api.betterttv.net/3/cached/emotes/global',
    channelUrl: (id) => `https://api.betterttv.net/3/cached/users/twitch/${id}`,
    parseGlobal: (j) => names(j, 'code'),
    parseChannel: (j) => [
      ...names(obj(j)['channelEmotes'], 'code'),
      ...names(obj(j)['sharedEmotes'], 'code')
    ]
  },
  {
    provider: 'FFZ',
    globalUrl: 'https://api.frankerfacez.com/v1/set/global',
    channelUrl: (id) => `https://api.frankerfacez.com/v1/room/id/${id}`,
    parseGlobal: (j) => ffzSets(j, arr(obj(j)['default_sets']).map(Number)),
    parseChannel: (j) => ffzSets(j)
  }
]

/** Ошибка HTTP 404: у канала просто нет эмоутов этого сервиса - это не сбой. */
export class NotFoundError extends Error {}

export class ThirdPartyEmotes {
  private byProvider = new Map<Provider, Set<string>>()
  private statuses: EmoteProviderStatus[] = PROVIDERS.map((p) => ({
    provider: p.provider,
    state: 'idle',
    count: 0,
    error: null
  }))
  private roomId: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** Номер загрузки: ответы старой загрузки (после смены канала) отбрасываются. */
  private generation = 0

  constructor(
    private readonly fetchJson: FetchJson,
    private readonly onStatus: (s: EmoteProviderStatus[]) => void
  ) {}

  /** Все известные имена эмоутов (с учётом регистра, как в чате). */
  has(word: string): boolean {
    for (const set of this.byProvider.values()) if (set.has(word)) return true
    return false
  }

  get status(): EmoteProviderStatus[] {
    return this.statuses.map((s) => ({ ...s }))
  }

  /** Канал сменился (или подтверждён вход): загрузить и запустить обновление. */
  async setRoom(roomId: string | null): Promise<void> {
    // id канала - только цифры (приходит от Twitch, но в адрес запроса подставляем осторожно).
    if (roomId !== null && !/^\d{1,20}$/.test(roomId)) roomId = null
    // Переподключение к тому же каналу: эмоуты не сбрасываем, иначе пока идёт загрузка (или
    // если она не удалась) эмоуты читались бы вслух. Список просто обновится.
    const same = roomId !== null && roomId === this.roomId
    this.roomId = roomId
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!same) this.byProvider.clear()
    if (!roomId) {
      this.generation++
      this.statuses = this.statuses.map((s) => ({ ...s, state: 'idle', count: 0, error: null }))
      this.onStatus(this.status)
      return
    }
    this.timer = setInterval(() => void this.load(), EMOTES_REFRESH_MS)
    await this.load()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async load(): Promise<void> {
    const roomId = this.roomId
    if (!roomId) return
    const gen = ++this.generation
    await Promise.all(
      PROVIDERS.map(async (p) => {
        this.setProvider(p.provider, { state: 'loading' })
        const words = new Set<string>()
        const errors: string[] = []
        const [g, c] = await Promise.allSettled([
          this.fetchJson(p.globalUrl),
          this.fetchJson(p.channelUrl(roomId))
        ])
        // Не больше MAX_WORDS на сервис: чужой огромный список не должен съесть память.
        const add = (w: string): void => {
          if (words.size < MAX_WORDS && w.length <= 100) words.add(w)
        }
        if (g.status === 'fulfilled') p.parseGlobal(g.value).forEach(add)
        else errors.push(`общие эмоуты (${errText(g.reason)})`)
        if (c.status === 'fulfilled') p.parseChannel(c.value).forEach(add)
        else if (!(c.reason instanceof NotFoundError))
          errors.push(`эмоуты канала (${errText(c.reason)})`)
        if (gen !== this.generation) return
        // Если загрузка не удалась совсем - оставляем прошлый список, чтобы не начать читать эмоуты вслух.
        if (words.size > 0 || errors.length === 0) this.byProvider.set(p.provider, words)
        this.setProvider(p.provider, {
          state: errors.length ? 'error' : 'ok',
          count: this.byProvider.get(p.provider)?.size ?? 0,
          error: errors.length ? `не загрузились ${errors.join(', ')}` : null
        })
      })
    )
  }

  private setProvider(provider: Provider, patch: Partial<EmoteProviderStatus>): void {
    this.statuses = this.statuses.map((s) => (s.provider === provider ? { ...s, ...patch } : s))
    this.onStatus(this.status)
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return 'сервис не ответил за 20 с'
    if (e.message === 'fetch failed') return 'нет связи с сервисом'
    return e.message
  }
  return String(e)
}

/** Сколько эмоутов одного сервиса держим в памяти максимум. */
const MAX_WORDS = 20_000

/** Ответ сервиса эмоутов больше этого - отказ (защита памяти от огромного или чужого ответа). */
export const MAX_EMOTES_RESPONSE = 5 * 1024 * 1024

/** Загрузка JSON с таймаутом 20 с и ограничением размера. 404 -> NotFoundError. */
export const httpFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) throw new NotFoundError('нет')
  if (!res.ok) throw new Error(`сервис ответил ошибкой ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_EMOTES_RESPONSE) throw new Error('слишком большой ответ сервиса')
  const text = await res.text()
  if (text.length > MAX_EMOTES_RESPONSE) throw new Error('слишком большой ответ сервиса')
  return JSON.parse(text) as unknown
}
