// Обновления через GitHub Releases.
//
// При запуске программа спрашивает GitHub о последнем релизе. Если он новее - окно
// "Обновить / Выйти" (обновление обязательное). Скачанный архив проверяется: SHA-256 и подпись
// Ed25519 (закрытый ключ только у автора, в программе открытый). Без верной подписи не ставим:
// так подменённый архив не пройдёт, даже если кто-то получит доступ к релизам.
//
// Установка - в install.ts: работающий exe заменить нельзя, поэтому файлы меняет отдельный
// скрипт после закрытия программы. Папка data\ (настройки, ключ, кэш) не трогается.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '@shared/version'
import type { UpdateState, UpdateStatus } from '@shared/types'

/** Самый большой архив, который согласны скачивать. */
export const MAX_UPDATE_BYTES = 500 * 1024 * 1024

export interface ReleaseInfo {
  version: string
  notes: string
  zipUrl: string
  zipName: string
  zipSize: number
  sigUrl: string
  /** Те же файлы через API GitHub: запасной путь, если обычная ссылка не отвечает. */
  zipApiUrl: string | null
  sigApiUrl: string | null
}

export interface UpdaterDeps {
  /** "owner/repo" на GitHub. Пусто - обновления выключены. */
  repo: string
  /** Открытый ключ подписи (PEM). Пусто - обновления выключены. */
  publicKeyPem: string
  currentVersion: string
  /** Папка для скачанного архива и журнала установки (внутри data\). */
  workDir: string
  fetchImpl?: typeof fetch
  /** Пауза между повторами (для тестов). */
  sleep?: (ms: number) => Promise<void>
}

/** Сколько раз пробуем скачать файл релиза и паузы между попытками. */
const ASSET_RETRY_MS = [2000, 5000]

/** Имя архива для Windows: TwitchTTS-0.2.0-win-x64.zip (как собирает electron-builder). */
const ZIP_RE = /-win-x64\.zip$/

export class Updater {
  private statusValue: UpdateStatus
  private release: ReleaseInfo | null = null
  private zipPath: string | null = null
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly deps: UpdaterDeps,
    private readonly onStatus: (s: UpdateStatus) => void = () => {}
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.statusValue =
      !deps.repo || !deps.publicKeyPem
        ? {
            state: 'off',
            current: deps.currentVersion,
            reason: 'в этой сборке обновления не подключены'
          }
        : { state: 'idle', current: deps.currentVersion }
  }

  get status(): UpdateStatus {
    return this.statusValue
  }

  private set(s: UpdateState): void {
    this.statusValue = { ...s, current: this.deps.currentVersion }
    this.onStatus(this.statusValue)
  }

  /** Отключить с причиной (например, папка программы недоступна для записи). */
  disable(reason: string): void {
    this.set({ state: 'off', reason })
  }

  /**
   * Спросить GitHub о последнем релизе. Новее текущей - состояние 'available'.
   * startup - проверка при запуске (окно "Обновить / Выйти"), иначе тихая пометка.
   */
  async check(startup = false): Promise<UpdateStatus> {
    if (this.statusValue.state === 'off') return this.statusValue
    const st = this.statusValue.state
    if (st === 'downloading' || st === 'ready' || st === 'installing') {
      return this.statusValue
    }
    this.set({ state: 'checking' })
    try {
      const res = await this.fetchImpl(
        `https://api.github.com/repos/${this.deps.repo}/releases/latest`,
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tts-updater' },
          signal: AbortSignal.timeout(15_000)
        }
      )
      if (res.status === 404) {
        this.set({ state: 'latest' })
        return this.statusValue
      }
      if (!res.ok) throw new Error(`GitHub ответил ошибкой ${res.status}`)
      const r = parseRelease(await res.json())
      if (!r) throw new Error('в последнем релизе нет архива программы или подписи')
      if (compareVersions(r.version, this.deps.currentVersion) <= 0) {
        this.set({ state: 'latest' })
        return this.statusValue
      }
      this.release = r
      this.set({
        state: 'available',
        version: r.version,
        notes: r.notes,
        sizeMb: mb(r.zipSize),
        startup
      })
    } catch (e) {
      this.set({ state: 'error', error: `не удалось проверить обновления: ${errText(e)}` })
    }
    return this.statusValue
  }

  /** Скачать и проверить архив. Готово - состояние 'ready', можно ставить. */
  async download(): Promise<UpdateStatus> {
    const r = this.release
    if (!r) return this.statusValue
    if (r.zipSize > MAX_UPDATE_BYTES) {
      this.set({ state: 'error', error: 'архив обновления слишком большой, обновление отменено' })
      return this.statusValue
    }
    this.set({ state: 'downloading', version: r.version, percent: 0 })
    try {
      mkdirSync(this.deps.workDir, { recursive: true })
      // Сначала маленькая подпись: если её не достать, большой архив качать незачем.
      const sigRes = await this.fetchAsset(r.sigUrl, r.sigApiUrl, 15_000, 'подпись не скачалась')
      const sig = Buffer.from((await sigRes.text()).trim(), 'base64')
      const file = join(this.deps.workDir, r.zipName)
      const zipRes = await this.fetchAsset(r.zipUrl, r.zipApiUrl, 15 * 60_000, 'архив не скачался')
      const hash = await this.saveToFile(zipRes, file, (p) =>
        this.set({ state: 'downloading', version: r.version, percent: p })
      )
      if (!verifySignature(hash, sig, this.deps.publicKeyPem)) {
        rmSync(file, { force: true })
        throw new Error(
          'подпись архива не сошлась: файл повреждён или подменён. Обновление не установлено'
        )
      }
      this.zipPath = file
      this.set({ state: 'ready', version: r.version })
    } catch (e) {
      this.set({ state: 'error', error: `обновление не скачалось: ${errText(e)}` })
    }
    return this.statusValue
  }

  /** Ход установки (распаковка) и её ошибка: показываются в том же окне обновления. */
  installing(percent: number): void {
    const r = this.release
    if (r) this.set({ state: 'installing', version: r.version, percent })
  }

  installFailed(error: string): void {
    this.set({ state: 'error', error: `обновление не установилось: ${error}` })
  }

  /** Путь к проверенному архиву (после download). */
  get readyZip(): string | null {
    return this.statusValue.state === 'ready' ? this.zipPath : null
  }

  /**
   * Файл релиза: обычная ссылка, при сбое запасная через API GitHub; всё это до 3 раз с паузами.
   * GitHub иногда отвечает 5xx на отдельные файлы, а через API тот же файл отдаётся.
   */
  private async fetchAsset(
    url: string,
    apiUrl: string | null,
    timeoutMs: number,
    failText: string
  ): Promise<Response> {
    const ways: [string, Record<string, string>][] = [[url, {}]]
    if (apiUrl)
      ways.push([apiUrl, { Accept: 'application/octet-stream', 'User-Agent': 'tts-updater' }])
    let last = ''
    for (let attempt = 0; attempt <= ASSET_RETRY_MS.length; attempt++) {
      if (attempt > 0) await this.sleep(ASSET_RETRY_MS[attempt - 1] ?? 5000)
      for (const [u, headers] of ways) {
        try {
          const res = await this.fetchImpl(u, { headers, signal: AbortSignal.timeout(timeoutMs) })
          if (res.ok && res.body) return res
          await res.body?.cancel()
          last = `GitHub ответил ошибкой ${res.status}`
        } catch (e) {
          last = errText(e)
        }
      }
    }
    throw new Error(`${failText} (${last}, 3 попытки не помогли)`)
  }

  private async saveToFile(
    res: Response,
    file: string,
    onProgress: (percent: number) => void
  ): Promise<string> {
    if (!res.body) throw new Error('сервер прислал пустой ответ')
    const total = Number(res.headers.get('content-length') ?? 0)
    const hash = createHash('sha256')
    const out = createWriteStream(file)
    let got = 0
    let lastPct = -1
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length
        if (got > MAX_UPDATE_BYTES) throw new Error('архив больше ожидаемого')
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
        const pct = total > 0 ? Math.floor((got / total) * 100) : 0
        if (pct !== lastPct) {
          lastPct = pct
          onProgress(pct)
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    return hash.digest('hex')
  }
}

/** Разбор ответа GitHub /releases/latest. null - нет нужных файлов. */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { tag_name?: unknown; body?: unknown; assets?: unknown }
  if (typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) return null
  const assets = r.assets as {
    name?: unknown
    browser_download_url?: unknown
    url?: unknown
    size?: unknown
  }[]
  const zip = assets.find((a) => typeof a.name === 'string' && ZIP_RE.test(a.name))
  if (!zip || typeof zip.name !== 'string' || typeof zip.browser_download_url !== 'string') {
    return null
  }
  const sig = assets.find((a) => a.name === `${String(zip.name)}.sig`)
  if (!sig || typeof sig.browser_download_url !== 'string') return null
  const https = (u: string): boolean => u.startsWith('https://')
  if (!https(zip.browser_download_url) || !https(sig.browser_download_url)) return null
  const api = (u: unknown): string | null =>
    typeof u === 'string' && u.startsWith('https://api.github.com/') ? u : null
  return {
    version: r.tag_name.replace(/^v/, ''),
    notes: typeof r.body === 'string' ? r.body.slice(0, 2000) : '',
    zipUrl: zip.browser_download_url,
    zipName: zip.name.replace(/[^\w.-]/g, '_'),
    zipSize: typeof zip.size === 'number' ? zip.size : 0,
    sigUrl: sig.browser_download_url,
    zipApiUrl: api(zip.url),
    sigApiUrl: api(sig.url)
  }
}

/** Подпись Ed25519 строки SHA-256 архива (hex). */
export function verifySignature(sha256hex: string, sig: Buffer, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(sha256hex), createPublicKey(publicKeyPem), sig)
  } catch {
    return false
  }
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

function errText(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError') return 'сервер не ответил вовремя'
    if (e.message === 'fetch failed') return 'нет связи с GitHub'
    return e.message
  }
  return String(e)
}
