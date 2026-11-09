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
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync
} from 'node:fs'
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
/** Сколько ждём ответа сервера (заголовков) и сколько терпим тишину посреди скачивания. */
const HEADERS_TIMEOUT_MS = 30_000
export const IDLE_TIMEOUT_MS = 45_000
/** Сколько раз продолжаем скачивание с места обрыва. */
export const RESUME_TRIES = 6
/** Свободного места нужно во столько раз больше архива: сам архив и распакованная копия. */
const SPACE_FACTOR = 4

/** Ошибка записи на диск: продолжать скачивание бессмысленно. */
class DiskError extends Error {}

/** Имя архива для Windows: TwitchTTS-0.2.0-win-x64.zip (как собирает electron-builder). */
const ZIP_RE = /-win-x64\.zip$/

export class Updater {
  private statusValue: UpdateStatus
  private release: ReleaseInfo | null = null
  private zipPath: string | null = null
  /** Идущее скачивание: чтобы его можно было отменить. */
  private abort: AbortController | null = null
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

  /** Отменить идущее скачивание. Скачанная часть остаётся: следующая попытка продолжит с неё. */
  cancel(): void {
    this.abort?.abort()
  }

  /**
   * Скачать и проверить архив. Готово - состояние 'ready', можно ставить.
   * Обрыв посреди скачивания не начинает всё сначала: программа продолжает с того же места.
   */
  async download(): Promise<UpdateStatus> {
    const r = this.release
    if (!r) return this.statusValue
    // Второй вызов, пока первый не закончил (двойной щелчок): два скачивания в один файл.
    if (this.abort) return this.statusValue
    if (r.zipSize > MAX_UPDATE_BYTES) {
      this.set({ state: 'error', error: 'архив обновления слишком большой, обновление отменено' })
      return this.statusValue
    }
    const ac = new AbortController()
    this.abort = ac
    this.set({ state: 'downloading', version: r.version, percent: 0 })
    try {
      mkdirSync(this.deps.workDir, { recursive: true })
      this.checkSpace(r.zipSize)
      // Сначала маленькая подпись: если её не достать, большой архив качать незачем.
      const sigGot = await this.fetchAsset(r.sigUrl, r.sigApiUrl, 'подпись не скачалась', ac.signal)
      const sig = Buffer.from((await sigGot.res.text()).trim(), 'base64')
      const file = join(this.deps.workDir, r.zipName)
      const hash = await this.downloadZip(r, file, ac.signal, (p) =>
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
      this.set({
        state: 'error',
        error: ac.signal.aborted
          ? 'скачивание отменено. Скачанная часть сохранена: при повторе программа продолжит с неё'
          : `обновление не скачалось: ${errText(e)}`
      })
    } finally {
      this.abort = null
    }
    return this.statusValue
  }

  /** Хватит ли места: иначе скачивание оборвётся на середине с непонятной ошибкой. */
  private checkSpace(zipSize: number): void {
    if (zipSize <= 0) return
    let free: number
    try {
      const s = statfsSync(this.deps.workDir)
      free = s.bavail * s.bsize
    } catch {
      return // не узнали - не мешаем, ошибку записи поймаем при скачивании
    }
    const need = zipSize * SPACE_FACTOR
    if (free < need)
      throw new Error(
        `на диске с программой мало места: нужно около ${Math.ceil(mb(need))} МБ, свободно ${Math.floor(mb(free))} МБ. Освободите место и повторите`
      )
  }

  /**
   * Архив: качаем в файл .part, при обрыве продолжаем с того же места (заголовок Range).
   * Возвращает SHA-256 готового файла.
   */
  private async downloadZip(
    r: ReleaseInfo,
    file: string,
    signal: AbortSignal,
    onProgress: (percent: number) => void
  ): Promise<string> {
    const part = `${file}.part`
    let last: unknown = null
    for (let attempt = 0; attempt < RESUME_TRIES; attempt++) {
      if (attempt > 0) await this.sleep(3000)
      if (signal.aborted) throw new Error('отменено')
      let have = existsSync(part) ? statSync(part).size : 0
      if (r.zipSize > 0 && have >= r.zipSize) {
        if (have === r.zipSize) break
        rmSync(part, { force: true })
        have = 0
      }
      try {
        const got = await this.fetchAsset(
          r.zipUrl,
          r.zipApiUrl,
          'архив не скачался',
          signal,
          have > 0 ? { Range: `bytes=${have}-` } : {}
        )
        // 206 - сервер продолжил с нужного места; 200 - прислал файл целиком, пишем заново.
        const append = have > 0 && got.res.status === 206
        await this.saveToFile(got.res, part, append ? have : 0, r.zipSize, got.kill, onProgress)
        last = null
        break
      } catch (e) {
        last = e
        if (signal.aborted || e instanceof DiskError) throw e
      }
    }
    if (last) throw last
    const hash = await sha256File(part)
    rmSync(file, { force: true })
    renameSync(part, file)
    return hash
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
    failText: string,
    signal: AbortSignal,
    extra: Record<string, string> = {}
  ): Promise<{ res: Response; kill: () => void }> {
    const ways: [string, Record<string, string>][] = [[url, {}]]
    if (apiUrl)
      ways.push([apiUrl, { Accept: 'application/octet-stream', 'User-Agent': 'tts-updater' }])
    let last = ''
    for (let attempt = 0; attempt <= ASSET_RETRY_MS.length; attempt++) {
      if (attempt > 0) await this.sleep(ASSET_RETRY_MS[attempt - 1] ?? 5000)
      for (const [u, headers] of ways) {
        if (signal.aborted) throw new Error('отменено')
        // Свой выключатель на каждый запрос: общий лимит времени на весь файл не годится для
        // медленного интернета, поэтому отдельно ждём заголовки, а дальше следим за тишиной.
        const own = new AbortController()
        const timer = setTimeout(() => own.abort(timeoutError()), HEADERS_TIMEOUT_MS)
        try {
          const res = await this.fetchImpl(u, {
            headers: { ...headers, ...extra },
            signal: AbortSignal.any([signal, own.signal])
          })
          if (res.ok && res.body) return { res, kill: () => own.abort(timeoutError()) }
          await res.body?.cancel()
          last = `GitHub ответил ошибкой ${res.status}`
        } catch (e) {
          last = errText(e)
        } finally {
          clearTimeout(timer)
        }
      }
    }
    throw new Error(`${failText} (${last}, 3 попытки не помогли)`)
  }

  /**
   * Записать тело ответа в файл (с начала или дописать после offset байт).
   * Ошибка диска - DiskError с понятной причиной; молчание сервера дольше IDLE_TIMEOUT_MS
   * обрывает запрос (kill), чтобы скачивание продолжилось новой попыткой.
   */
  private async saveToFile(
    res: Response,
    file: string,
    offset: number,
    total: number,
    kill: () => void,
    onProgress: (percent: number) => void
  ): Promise<void> {
    if (!res.body) throw new Error('сервер прислал пустой ответ')
    const out = createWriteStream(file, { flags: offset > 0 ? 'a' : 'w' })
    // Ошибка записи приходит событием, а не исключением: без обработчика скачивание висело бы
    // на ожидании "диск готов принять ещё" бесконечно.
    const disk: { error: Error | null } = { error: null }
    const failed = new Promise<never>((_, reject) =>
      out.once('error', (e) => {
        disk.error = new DiskError(diskText(e))
        reject(disk.error)
      })
    )
    failed.catch(() => {})
    let got = offset
    let lastPct = -1
    let idle = setTimeout(kill, IDLE_TIMEOUT_MS)
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(idle)
        idle = setTimeout(kill, IDLE_TIMEOUT_MS)
        if (disk.error) throw disk.error
        got += chunk.length
        if (got > MAX_UPDATE_BYTES) throw new Error('архив больше ожидаемого')
        if (!out.write(chunk))
          await Promise.race([new Promise<void>((r) => out.once('drain', () => r())), failed])
        const pct = total > 0 ? Math.min(100, Math.floor((got / total) * 100)) : 0
        if (pct !== lastPct) {
          lastPct = pct
          onProgress(pct)
        }
      }
    } catch (e) {
      throw disk.error ?? e
    } finally {
      clearTimeout(idle)
      await new Promise<void>((r) => {
        if (out.destroyed) r()
        else out.end(() => r())
      })
    }
    if (disk.error) throw disk.error
    if (total > 0 && got < total) throw new Error('соединение оборвалось')
  }
}

const timeoutError = (): Error => Object.assign(new Error('timeout'), { name: 'TimeoutError' })

/** Причина сбоя записи для человека. */
function diskText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'ENOSPC')
    return 'на диске с программой кончилось место. Освободите место и повторите'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY')
    return 'файл обновления занят другой программой (часто это антивирус) или нет доступа к папке. Подождите минуту и повторите'
  return `не удалось записать файл обновления (${e instanceof Error ? e.message : String(e)})`
}

/** SHA-256 файла, не загружая его в память целиком. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
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
