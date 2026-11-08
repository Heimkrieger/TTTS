// Синтез для очереди: настройки голоса + кэш + счёт расходов поверх клиента Fish.
import { EventEmitter } from 'node:events'
import { FISH_PRICE_PER_MB, type FishModel, type Settings } from '@shared/settings'
import type { BudgetStatus, TtsStats } from '@shared/types'
import { BudgetPauseError, DailyBudget, decideModel, FREE_MODEL } from './budget'
import type { SynthResult, TtsProvider } from '../queue/queue'
import { AudioCache, cacheKey } from './cache'
import type { FishClient } from './fish'

export interface ProviderEvents {
  stats: [TtsStats]
  /** Лимит исчерпан и чтение перешло на бесплатную модель (один раз за день). */
  limit: [text: string]
}

export class FishProvider extends EventEmitter<ProviderEvents> implements TtsProvider {
  private statsValue: TtsStats = { requests: 0, cacheHits: 0, bytes: 0, costUsd: 0 }
  /** В какой день уже сообщили о переходе на бесплатную модель. */
  private limitNoticeDay = ''

  constructor(
    private readonly client: FishClient,
    private readonly cache: AudioCache,
    private readonly getSettings: () => Readonly<Settings>,
    private readonly budget: DailyBudget = new DailyBudget(null)
  ) {
    super()
  }

  /** Состояние дневного бюджета для окна. */
  budgetStatus(): BudgetStatus {
    const t = this.getSettings().tts
    const spentUsd = this.budget.spent()
    const active = FISH_PRICE_PER_MB[t.model] > 0 && t.budget.dailyUsd > 0
    return {
      active,
      spentUsd,
      limitUsd: t.budget.dailyUsd,
      exceeded: active && spentUsd >= t.budget.dailyUsd,
      onLimit: t.budget.onLimit
    }
  }

  get stats(): TtsStats {
    return { ...this.statsValue }
  }

  async synthesize(
    text: string,
    opts: { speed: number; signal: AbortSignal; voiceId?: string }
  ): Promise<SynthResult> {
    const t = this.getSettings().tts
    const voiceId = opts.voiceId ?? t.voiceId
    const paramsFor = (model: FishModel) => ({
      text,
      model,
      voiceId,
      temperature: t.temperature,
      topP: t.topP,
      speed: opts.speed
    })
    // Сначала кэш: готовая запись бесплатна, лимит её не касается (повтор из истории и т.п.).
    const fromCache = (model: FishModel): SynthResult | null => {
      const hit = this.cache.get(cacheKey(paramsFor(model)))
      if (!hit) return null
      this.statsValue.cacheHits++
      this.emit('stats', this.stats)
      return hit
    }
    const preferred = fromCache(t.model)
    if (preferred) return preferred
    const decision = decideModel(t.model, t.budget, this.budget.spent())
    if (decision.action === 'pause') throw new BudgetPauseError(decision.reason)
    if (decision.switchedToFree) this.noticeLimit(t.budget.dailyUsd)
    const model = decision.model
    if (model !== t.model) {
      const free = fromCache(model)
      if (free) return free
    }
    const params = paramsFor(model)
    const key = cacheKey(params)
    const r = await this.client.synthesize(params, opts.signal)
    // Запрос уже оплачен: если записать в кэш не вышло, звук всё равно отдаём и деньги учитываем.
    try {
      this.cache.put(key, r.audio, r.durationSec)
    } catch {
      // кэш - только ускорение
    }
    // Fish считает деньги по байтам UTF-8 текста: кириллица - 2 байта на букву.
    const bytes = Buffer.byteLength(text, 'utf8')
    this.statsValue.requests++
    this.statsValue.bytes += bytes
    const cost = (bytes / 1_000_000) * FISH_PRICE_PER_MB[model]
    this.statsValue.costUsd += cost
    this.budget.add(cost)
    this.emit('stats', this.stats)
    return r
  }

  private noticeLimit(limitUsd: number): void {
    const day = new Date().toDateString()
    if (this.limitNoticeDay === day) return
    this.limitNoticeDay = day
    this.emit(
      'limit',
      `Дневной лимит $${limitUsd.toFixed(2)} на платную модель кончился: до полуночи читает бесплатная модель ${FREE_MODEL} тем же ключом и голосом.`
    )
  }
}
