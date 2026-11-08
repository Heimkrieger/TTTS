// Дневной бюджет на платные модели Fish.
// Считаем деньги за день (по местному времени, новый день с полуночи) и храним в файле, чтобы
// перезапуск программы не обнулял счётчик. Когда лимит исчерпан - по выбору стримера: читать
// бесплатной моделью тем же ключом или поставить озвучку на паузу.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { FISH_PRICE_PER_MB, type FishModel } from '@shared/settings'

export const FREE_MODEL: FishModel = 's2.1-pro-free'

/** Дата по местному времени: "2026-11-09". */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface BudgetSettings {
  /** Лимит в $ на день. 0 - без лимита. */
  dailyUsd: number
  onLimit: 'free' | 'pause'
}

export type ModelDecision =
  { action: 'use'; model: FishModel; switchedToFree: boolean } | { action: 'pause'; reason: string }

/** Какой моделью синтезировать с учётом лимита. Бесплатная модель лимитом не ограничена. */
export function decideModel(model: FishModel, b: BudgetSettings, spentUsd: number): ModelDecision {
  const paid = FISH_PRICE_PER_MB[model] > 0
  if (!paid || b.dailyUsd <= 0 || spentUsd < b.dailyUsd) {
    return { action: 'use', model, switchedToFree: false }
  }
  if (b.onLimit === 'free') return { action: 'use', model: FREE_MODEL, switchedToFree: true }
  return {
    action: 'pause',
    reason:
      `дневной лимит $${b.dailyUsd.toFixed(2)} на платную модель кончился (потрачено $${spentUsd.toFixed(2)}). ` +
      'Поднимите лимит в разделе "Голос" или выберите бесплатную модель и нажмите "Продолжить". После полуночи счёт начнётся заново.'
  }
}

/** Счётчик трат за сегодня, сохраняется в файл. */
export class DailyBudget {
  private state = { day: '', spentUsd: 0 }

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
    /** Не удалось сохранить счётчик: причина в журнал. */
    private readonly onError: (text: string) => void = () => {}
  ) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { day?: unknown; spentUsd?: unknown }
        if (typeof raw.day === 'string' && typeof raw.spentUsd === 'number' && raw.spentUsd >= 0) {
          this.state = { day: raw.day, spentUsd: raw.spentUsd }
        }
      } catch {
        // Повреждённый файл: начинаем день с нуля (это только счётчик, не деньги).
      }
    }
  }

  /** Потрачено сегодня, $. */
  spent(): number {
    this.roll()
    return this.state.spentUsd
  }

  add(usd: number): void {
    if (usd <= 0) return
    this.roll()
    this.state.spentUsd += usd
    this.save()
  }

  private roll(): void {
    const today = dayKey(this.now())
    if (this.state.day !== today) this.state = { day: today, spentUsd: 0 }
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      // Через временный файл: если программу закроют посреди записи, старый счётчик цел.
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state))
      renameSync(tmp, this.file)
    } catch {
      this.onError(
        'Не удалось сохранить счётчик трат за день. До перезапуска он считает верно, после перезапуска может начаться с нуля. Проверьте, что папка программы доступна для записи.'
      )
    }
  }
}

/** Ошибка "лимит исчерпан, пауза": очередь видит fatal и встаёт на паузу с этой причиной. */
export class BudgetPauseError extends Error {
  readonly fatal = true
}
