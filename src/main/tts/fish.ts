// Клиент Fish Audio. API: https://docs.fish.audio/api-reference/openapi.json
//
// Синтез: POST https://api.fish.audio/v1/tts, заголовок model, тело { text, reference_id, format,
// temperature, top_p, prosody: { speed, volume } }, в ответ - mp3.
// Ошибки: 401 - неверный ключ, 402 - нет кредитов, 429 - лимит одновременных запросов (5),
// 503/5xx - перегрузка. На 401/402 очередь ставится на паузу: дальше всё равно не получится.
import type { FishModel } from '@shared/settings'
import { mp3Duration } from './mp3'

export const FISH_API = 'https://api.fish.audio'
export const SYNTH_TIMEOUT_MS = 20_000
/** Повторы при 429 и 5xx: задержки перед попытками 2 и 3. */
export const RETRY_DELAYS_MS = [1000, 3000]

export interface FishVoice {
  id: string
  title: string
  languages: string[]
  author: string
  uses: number
}

export interface FishSynthParams {
  text: string
  model: FishModel
  voiceId: string
  temperature: number
  topP: number
  speed: number
}

/** Ошибка, после которой очередь ставится на паузу (ключ или деньги). */
export class FishFatalError extends Error {
  /** Очередь видит это поле и встаёт на паузу. */
  readonly fatal = true
  constructor(
    message: string,
    readonly code: 'auth' | 'credit'
  ) {
    super(message)
  }
}

export class FishError extends Error {}

type Fetch = typeof fetch

export class FishClient {
  constructor(
    private readonly getKey: () => string | null,
    private readonly fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ) {}

  private headers(): Record<string, string> {
    const key = this.getKey()
    if (!key)
      throw new FishFatalError(
        'Нет ключа Fish Audio или сохранённый ключ не читается на этом компьютере. Добавьте ключ в разделе "Подключение".',
        'auth'
      )
    return { Authorization: `Bearer ${key}` }
  }

  /** Синтез фразы. Повторяет 2 раза при перегрузке, на 401/402 - FishFatalError. */
  async synthesize(
    p: FishSynthParams,
    signal?: AbortSignal
  ): Promise<{ audio: Buffer; durationSec: number }> {
    const body = JSON.stringify({
      text: p.text,
      reference_id: p.voiceId || null,
      format: 'mp3',
      mp3_bitrate: 128,
      temperature: p.temperature,
      top_p: p.topP,
      prosody: { speed: p.speed, volume: 0 }
    })
    let lastError = ''
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await this.sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3000)
      if (signal?.aborted) throw new FishError('отменено')
      const timeout = AbortSignal.timeout(SYNTH_TIMEOUT_MS)
      let res: Response
      try {
        res = await this.fetchImpl(`${FISH_API}/v1/tts`, {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json', model: p.model },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        })
      } catch (e) {
        if (e instanceof FishFatalError) throw e
        if (signal?.aborted) throw new FishError('отменено')
        lastError =
          e instanceof Error && e.name === 'TimeoutError'
            ? `Fish не ответил за ${SYNTH_TIMEOUT_MS / 1000} с`
            : 'нет связи с Fish Audio'
        continue
      }
      if (res.ok) {
        const audio = Buffer.from(await res.arrayBuffer())
        const durationSec = mp3Duration(audio)
        if (durationSec === null)
          throw new FishError('Fish прислал испорченный звук, сообщение пропущено')
        return { audio, durationSec }
      }
      const msg = await errorMessage(res)
      if (res.status === 401) {
        throw new FishFatalError(
          'Ключ Fish Audio неверный или отозван. Проверьте ключ в разделе "Подключение".',
          'auth'
        )
      }
      if (res.status === 402) {
        throw new FishFatalError(
          p.model === 's2.1-pro-free'
            ? `Fish отказал даже на бесплатной модели: на аккаунте кончился лимит. Проверьте аккаунт на fish.audio или подождите. Ответ Fish: ${msg}`
            : `Кончились деньги на балансе Fish Audio для модели ${p.model}. Пополните баланс на fish.audio или выберите бесплатную модель s2.1-pro-free.`,
          'credit'
        )
      }
      if (res.status === 429 || res.status >= 500) {
        lastError =
          res.status === 429
            ? 'Fish: слишком много запросов одновременно'
            : `Fish перегружен (ошибка ${res.status})`
        continue
      }
      throw new FishError(
        `Fish отклонил запрос (ошибка ${res.status}): ${msg}. Сообщение пропущено. Если повторяется, отправьте отчёт через "Сообщить о проблеме".`
      )
    }
    throw new FishError(
      `${lastError}, 3 попытки не помогли. Проверьте интернет и нажмите "Проверить связь" в разделе "Подключение".`
    )
  }

  /** Доступен ли сервер Fish вообще (без ключа): время ответа в мс или ошибка. */
  async ping(): Promise<number> {
    const t0 = Date.now()
    const res = await this.fetchImpl(`${FISH_API}/model?page_size=1`, {
      signal: AbortSignal.timeout(15_000)
    })
    await res.arrayBuffer()
    if (res.status >= 500) throw new FishError(`сервер Fish ответил ошибкой ${res.status}`)
    return Date.now() - t0
  }

  /** Баланс API в долларах (строкой, как отдаёт Fish). */
  async balance(): Promise<string> {
    const res = await this.fetchImpl(`${FISH_API}/wallet/self/api-credit`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 401)
      throw new FishFatalError(
        'Ключ Fish Audio неверный. Замените его в разделе "Подключение".',
        'auth'
      )
    if (!res.ok) throw new FishError(`Fish ответил ошибкой ${res.status}`)
    const j = (await res.json()) as { credit?: unknown }
    return typeof j.credit === 'string' ? j.credit : String(j.credit ?? '?')
  }

  /** Поиск голосов по названию (русские и все языки). */
  async searchVoices(query: string, language: string | null): Promise<FishVoice[]> {
    const q = new URLSearchParams({ page_size: '20', sort_by: 'score' })
    if (query.trim()) q.set('title', query.trim())
    if (language) q.set('language', language)
    const res = await this.fetchImpl(`${FISH_API}/model?${q}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok)
      throw new FishError(
        `Поиск голосов не удался: Fish ответил ошибкой ${res.status}. Попробуйте через минуту.`
      )
    const j = (await res.json()) as { items?: unknown[] }
    return (j.items ?? []).map(toVoice).filter((v): v is FishVoice => v !== null)
  }

  async getVoice(id: string): Promise<FishVoice> {
    const res = await this.fetchImpl(`${FISH_API}/model/${encodeURIComponent(id)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000)
    })
    if (res.status === 404)
      throw new FishError(
        'Голос не найден на fish.audio. Откройте его страницу на сайте и скопируйте адрес из браузера.'
      )
    if (!res.ok)
      throw new FishError(
        `Голос не загрузился: Fish ответил ошибкой ${res.status}. Попробуйте через минуту.`
      )
    const v = toVoice(await res.json())
    if (!v)
      throw new FishError(
        'Fish вернул непонятный ответ о голосе. Попробуйте ещё раз или выберите голос через поиск.'
      )
    return v
  }
}

/** id голоса из ссылки fish.audio (32 hex-символа) или из самого id. */
export function parseVoiceId(input: string): string | null {
  const m = /[0-9a-f]{32}/i.exec(input.trim())
  return m ? m[0].toLowerCase() : null
}

function toVoice(raw: unknown): FishVoice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o._id !== 'string' || typeof o.title !== 'string') return null
  const author = (o.author as Record<string, unknown> | undefined)?.nickname
  return {
    id: o._id,
    title: o.title,
    languages: Array.isArray(o.languages)
      ? o.languages.filter((x): x is string => typeof x === 'string')
      : [],
    author: typeof author === 'string' ? author : '',
    uses: typeof o.task_count === 'number' ? o.task_count : 0
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: unknown }
    return typeof j.message === 'string' ? j.message : `ошибка ${res.status}`
  } catch {
    return `ошибка ${res.status}`
  }
}
