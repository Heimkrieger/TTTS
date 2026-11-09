// Fish Audio для окна: состояние ключа и баланса, голоса (поиск, избранное, выбор), тест голоса.
import { EventEmitter } from 'node:events'
import type { CheckStep, ConnectionCheck, FishStatus, Result, VoiceInfo } from '@shared/types'
import type { Journal } from '../journal'
import type { SettingsStore } from '../settings'
import { FishClient, FishFatalError, parseVoiceId } from './fish'
import type { FishProvider } from './provider'

export const BALANCE_EVERY_MS = 5 * 60_000

export class FishService extends EventEmitter<{ status: [FishStatus] }> {
  private balance: string | null = null
  private error: string | null = null
  private keyCheck: FishStatus['keyCheck'] = 'unknown'
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly store: SettingsStore,
    private readonly client: FishClient,
    private readonly provider: FishProvider,
    private readonly journal: Journal,
    /** Ключ из .env (только в режиме разработки). */
    private readonly envKey: string | null
  ) {
    super()
    provider.on('stats', () => this.emitStatus())
    provider.on('limit', (text) => {
      this.journal.add('warn', text)
      this.emitStatus()
    })
  }

  /** Ключ для запросов: из настроек (зашифрованный), иначе из .env в разработке. */
  getKey(): string | null {
    return this.store.getFishKey() ?? this.envKey
  }

  status(): FishStatus {
    const own = this.store.getPublic().fishKey
    return {
      key: own === 'ok' ? 'ok' : this.envKey ? 'env' : own,
      balance: this.balance,
      error: this.error,
      keyCheck: this.keyCheck,
      stats: this.provider.stats,
      budget: this.provider.budgetStatus()
    }
  }

  /** Переслать состояние в окно (например, после смены модели или лимита). */
  emitStatus(): void {
    this.emit('status', this.status())
  }

  start(): void {
    void this.refreshBalance()
    this.timer = setInterval(() => void this.refreshBalance(), BALANCE_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Ошибка синтеза из очереди: показать в окне. null - снять. */
  setError(text: string | null): void {
    this.error = text
    this.emitStatus()
  }

  async refreshBalance(): Promise<void> {
    if (!this.getKey()) {
      this.balance = null
      this.error = null
      this.keyCheck = 'unknown'
      this.emitStatus()
      return
    }
    try {
      this.balance = await this.client.balance()
      this.error = null
      this.keyCheck = 'works'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof FishFatalError) this.keyCheck = 'rejected'
      if (e instanceof FishFatalError || this.error !== msg)
        this.journal.add('warn', `Fish: ${msg}`)
      this.error = e instanceof FishFatalError ? msg : `баланс не обновился: ${msg}`
    }
    this.emitStatus()
  }

  async searchVoices(query: string, language: string | null): Promise<Result<VoiceInfo[]>> {
    try {
      return { ok: true, value: await this.client.searchVoices(query, language) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Добавить голос в избранное по ссылке или id (и сразу выбрать). */
  async addVoice(input: string): Promise<Result<VoiceInfo>> {
    const id = parseVoiceId(input)
    if (!id) {
      return {
        ok: false,
        error:
          'Это не похоже на ссылку на голос. Откройте голос на fish.audio и скопируйте адрес страницы из браузера.'
      }
    }
    try {
      const v = await this.client.getVoice(id)
      this.saveFavorite(v.id, v.title)
      return { ok: true, value: v }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Сохранить в избранное и выбрать. */
  saveFavorite(id: string, title: string): void {
    const t = this.store.current().tts
    const voices = [...t.voices.filter((v) => v.id !== id), { id, title }]
    this.store.update({ tts: { voices, voiceId: id } })
    this.journal.add('info', `Голос: ${title}`)
  }

  removeFavorite(id: string): void {
    const t = this.store.current().tts
    this.store.update({
      tts: {
        voices: t.voices.filter((v) => v.id !== id),
        voiceId: t.voiceId === id ? '' : t.voiceId
      }
    })
  }

  /**
   * Проверка связи с Fish по шагам: сервер, ключ, синтез. Синтез - всегда на бесплатной модели
   * и мимо кэша, чтобы измерить настоящее время и не тратить деньги.
   */
  async checkConnection(): Promise<ConnectionCheck> {
    const steps: CheckStep[] = []
    const errText = (e: unknown): string => {
      if (e instanceof Error && e.name === 'TimeoutError') return 'нет ответа за 15 с'
      if (e instanceof Error && e.message === 'fetch failed')
        return 'нет связи (сервер недоступен или заблокирован)'
      return e instanceof Error ? e.message : String(e)
    }

    // 1. Сервер Fish.
    try {
      const ms = await this.client.ping()
      steps.push({
        title: 'Сервер Fish Audio',
        state: ms < 3000 ? 'ok' : 'warn',
        ms,
        detail: ms < 3000 ? 'доступен' : 'доступен, но отвечает медленно'
      })
    } catch (e) {
      steps.push({ title: 'Сервер Fish Audio', state: 'fail', ms: null, detail: errText(e) })
      return finish(steps)
    }

    // 2. Ключ.
    if (!this.getKey()) {
      steps.push({ title: 'Ключ', state: 'fail', ms: null, detail: 'ключ не добавлен' })
      return finish(steps)
    }
    try {
      const t0 = Date.now()
      const bal = await this.client.balance()
      this.balance = bal
      steps.push({
        title: 'Ключ',
        state: 'ok',
        ms: Date.now() - t0,
        detail: `работает, баланс $${Number(bal).toFixed(2)}`
      })
    } catch (e) {
      steps.push({ title: 'Ключ', state: 'fail', ms: null, detail: errText(e) })
      return finish(steps)
    }

    // 3. Синтез.
    try {
      const t = this.store.current().tts
      const t0 = Date.now()
      const r = await this.client.synthesize({
        text: `Проверка связи ${t0 % 1000}.`,
        model: 's2.1-pro-free',
        voiceId: t.voiceId,
        temperature: t.temperature,
        topP: t.topP,
        speed: 1
      })
      const ms = Date.now() - t0
      steps.push({
        title: 'Пробная озвучка',
        state: ms < 4000 ? 'ok' : 'warn',
        ms,
        detail: `звук ${r.durationSec.toFixed(1)} с${ms < 4000 ? '' : ', медленно'}`
      })
    } catch (e) {
      steps.push({ title: 'Пробная озвучка', state: 'fail', ms: null, detail: errText(e) })
    }
    this.emitStatus()
    return finish(steps)
  }

  /** Тест голоса: синтез фразы мимо очереди (с кэшем). voiceId - послушать другой голос, не выбирая его. */
  async test(
    text: string,
    voiceId?: string
  ): Promise<Result<{ audio: Uint8Array; durationSec: number }>> {
    const phrase = text.trim() || 'Привет, чат. Это проверка голоса.'
    try {
      const r = await this.provider.synthesize(phrase, {
        speed: this.store.current().tts.speed,
        signal: AbortSignal.timeout(30_000),
        voiceId
      })
      if (!r.audio) return { ok: false, error: 'Fish не прислал звук. Попробуйте ещё раз.' }
      this.setError(null)
      return { ok: true, value: { audio: new Uint8Array(r.audio), durationSec: r.durationSec } }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof FishFatalError) this.setError(msg)
      return { ok: false, error: msg }
    }
  }
}

function finish(steps: CheckStep[]): ConnectionCheck {
  const failed = steps.find((s) => s.state === 'fail')
  if (failed) {
    const hint =
      failed.title === 'Сервер Fish Audio'
        ? 'Проверьте интернет. Если интернет есть, сервер Fish недоступен из вашей сети: попробуйте VPN.'
        : failed.title === 'Ключ'
          ? 'Добавьте или замените ключ: fish.audio, раздел API Keys.'
          : 'Сервер и ключ в порядке, но пробная озвучка не прошла. Повторите проверку через минуту.'
    return {
      steps,
      ok: false,
      verdict: `Озвучка не будет работать. ${failed.title}: ${failed.detail.replace(/\.$/, '')}. ${hint}`
    }
  }
  const slow = steps.some((s) => s.state === 'warn')
  return {
    steps,
    ok: true,
    verdict: slow
      ? 'Работает, но медленно. Следующее сообщение готовится заранее, поэтому задержку будет слышно в основном после тишины.'
      : 'Всё работает.'
  }
}
