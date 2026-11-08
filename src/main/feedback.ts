// Фидбек: отчёт об ошибке или идея от пользователя уходит автору одной кнопкой, без аккаунтов.
// Программа шлёт отчёт посреднику (feedback-relay/, Cloudflare Worker), тот пересылает его в
// Telegram. Ключ бота живёт у посредника, в коде программы его нет.
//
// Анонимность: в отчёт не попадают ключи, токены, имя пользователя Windows в путях, IP-адреса.
// Пользователь видит отчёт целиком до отправки (preview) - уходит ровно то, что он видел.
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { FeedbackDraft, FeedbackReport, Result } from '@shared/types'
import { sendToAuthor } from '@shared/brand'

/** Сколько последних строк журнала прикладывать. */
export const LOG_LINES = 150
/** Потолок длины текста пользователя и журнала (символов). */
export const MAX_TEXT = 4000
export const MAX_LOG = 15000
/** Не чаще одного отчёта в минуту: защита от случайных повторов и спама. */
export const MIN_INTERVAL_MS = 60_000

/**
 * Убирает из текста всё, что может раскрыть стримера или его доступы:
 * имя пользователя Windows в путях, IP-адреса, ключи и токены, почту.
 */
export function scrub(text: string): string {
  return (
    text
      // C:\Users\Имя\... и C:/Users/Имя/...
      // (имя может быть с пробелами, поэтому берём всё до следующей косой черты или конца строки)
      .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"'<>|:]+/gi, '$1<user>')
      // Сетевые пути \\компьютер\папка\...: скрываем целиком (в папках бывают имена людей)
      .replace(/\\\\[^\\/\s"'<>|]+(?:\\[^\\\s"'<>|]+)*/g, '<сетевой путь>')
      // Короткие пути Windows вида IVANPE~1 и ИВАНПЕ~1
      .replace(/(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]{1,8}~\d(?![\p{L}\p{N}])/gu, '<user>')
      // IPv4 (кроме 127.x и 0.0.0.0: это сам компьютер, не адрес стримера)
      .replace(/\b(?!127\.|0\.0\.0\.0)(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
      // IPv6 (кроме ::1)
      .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '<ip>')
      // Почта
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
      // Заголовки и параметры с секретами: Authorization: Bearer ..., token=..., api_key=...
      .replace(/(bearer\s+)[\w.~+/-]+=*/gi, '$1<secret>')
      .replace(
        /((?:api[_-]?key|token|secret|password|authorization)["'\s:=]+)[^\s"',;]+/gi,
        '$1<secret>'
      )
      // Длинные строки из букв и цифр (32+ символа) - похожи на ключи
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<secret>')
  )
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Последние строки файла журнала (или пусто, если файла нет). */
export function readLogTail(file: string, lines = LOG_LINES): string {
  if (!existsSync(file)) return ''
  // Журнал может быть большим: читаем только хвост.
  const size = statSync(file).size
  const buf = readFileSync(file)
  const text = buf.subarray(Math.max(0, size - 200_000)).toString('utf8')
  return text
    .split(/\r?\n/)
    .slice(-lines - 1)
    .join('\n')
    .trim()
}

/** Отчёт, который уйдёт: всё уже очищено. Его же пользователь видит перед отправкой. */
/** Заменить слово целиком (без учёта регистра), а не кусок другого слова. */
function replaceWord(text: string, word: string, token: string): string {
  if (word.length < 2) return text
  return text.replace(
    new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, 'giu'),
    token
  )
}

/** Местное время с поясом: "08.11.2026 21:32 (UTC+3)". В журнале время тоже местное. */
export function localTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const h = Math.trunc(Math.abs(off) / 60)
  const m = Math.abs(off) % 60
  const zone = `UTC${off < 0 ? '-' : '+'}${h}${m ? `:${p(m)}` : ''}`
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())} (${zone})`
}

export interface ReportEnv {
  appVersion: string
  os: string
  logFile: string
  /** Каналы этой сессии (текущий и прежние): отчёт не должен говорить, чей это стрим. */
  channels: string[]
  /** Ники зрителей (лента, мьюты, чёрный список): по списку зрителей тоже можно найти канал. */
  viewers: string[]
  /** Текущее время (для тестов). */
  now?: number
  /** Пути и имена этого компьютера: папка программы, домашняя папка, имя компьютера и пользователя. */
  literals: string[]
}

export function buildReport(draft: FeedbackDraft, env: ReportEnv): FeedbackReport {
  const hide = (t: string): string => {
    let out = t
    // Сначала длинные строки (пути), потом короткие: иначе путь заменился бы по кусочкам.
    for (const l of [...env.literals]
      .filter((x) => x.length >= 3)
      .sort((a, b) => b.length - a.length)) {
      for (const v of new Set([l, l.replaceAll('\\', '/'), l.replaceAll('/', '\\')])) {
        out = out.replace(new RegExp(escapeRe(v), 'gi'), '<local>')
      }
    }
    out = scrub(out)
    for (const c of env.channels) out = replaceWord(out, c, '<channel>')
    for (const v of env.viewers) out = replaceWord(out, v, '<viewer>')
    return out
  }
  const log = draft.attachLog ? hide(readLogTail(env.logFile)).slice(-MAX_LOG) : ''
  return {
    kind: draft.kind,
    text: hide(draft.text.trim()).slice(0, MAX_TEXT),
    contact: draft.contact.trim().slice(0, 200),
    appVersion: env.appVersion,
    os: env.os,
    sentAt: localTime(env.now ?? Date.now()),
    log
  }
}

export type PostJson = (url: string, body: unknown) => Promise<{ status: number }>

export class FeedbackSender {
  private lastSentAt = 0

  constructor(
    private readonly url: string,
    private readonly post: PostJson,
    private readonly now: () => number = Date.now
  ) {}

  /** Адрес посредника задан (иначе кнопка "Отправить" объясняет, что отправка не настроена). */
  get configured(): boolean {
    return this.url !== ''
  }

  async send(report: FeedbackReport): Promise<Result<null>> {
    if (!this.configured) {
      return {
        ok: false,
        error: `Отправка отзывов в этой версии ещё не подключена. Скопируйте текст кнопкой "Скопировать" и ${sendToAuthor()}.`
      }
    }
    if (report.text.length < 5)
      return {
        ok: false,
        error: 'Напишите хотя бы пару слов о том, что случилось или что улучшить.'
      }
    const wait = this.lastSentAt + MIN_INTERVAL_MS - this.now()
    if (wait > 0) {
      return {
        ok: false,
        error: `Отчёт уже отправлен. Следующий можно через ${Math.ceil(wait / 1000)} с.`
      }
    }
    try {
      const r = await this.post(this.url, report)
      if (r.status === 429) {
        return { ok: false, error: 'Слишком много отчётов подряд. Попробуйте через пару минут.' }
      }
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          error: `Сервер отзывов ответил ошибкой ${r.status}. Попробуйте позже или скопируйте текст и ${sendToAuthor()}.`
        }
      }
      this.lastSentAt = this.now()
      return { ok: true, value: null }
    } catch {
      return {
        ok: false,
        error: `Нет связи с сервером отзывов. Проверьте интернет или скопируйте текст и ${sendToAuthor()}.`
      }
    }
  }
}

/** Реальная отправка: POST JSON с таймаутом 15 с. */
export const httpPostJson: PostJson = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  })
  return { status: res.status }
}
