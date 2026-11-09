// Кэш синтезированного аудио: одинаковая фраза тем же голосом не синтезируется повторно (не тратит деньги).
// Ключ = sha1(текст + голос + модель + параметры). Файлы в <папка данных>/cache, LRU на 200 МБ.
//
// Кэш - только ускорение: любая его ошибка (нет места, файл занят антивирусом) не должна мешать
// озвучке. Чтение при сбое отвечает "нет записи", запись сообщает о сбое через onError.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export const CACHE_MAX_BYTES = 200 * 1024 * 1024
/** Отметки "когда использовали" пишутся на диск не на каждое сообщение, а раз в столько мс. */
export const INDEX_SAVE_DELAY_MS = 5000

interface Entry {
  size: number
  durationSec: number
  lastUsed: number
}

export function cacheKey(parts: Record<string, string | number>): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex')
}

const isEntry = (v: unknown): v is Entry => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.size === 'number' &&
    typeof e.durationSec === 'number' &&
    typeof e.lastUsed === 'number'
  )
}

export class AudioCache {
  private index = new Map<string, Entry>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dir: string,
    private readonly maxBytes = CACHE_MAX_BYTES,
    private readonly now: () => number = Date.now,
    /** Сбой чтения или записи: причина для журнала. Озвучке сбой не мешает. */
    private readonly onError: (reason: string) => void = () => {}
  ) {
    try {
      mkdirSync(dir, { recursive: true })
      const raw: unknown = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
      // Ключ - sha1 (40 шестнадцатеричных знаков): по нему строится имя файла, чужое не пускаем.
      if (raw && typeof raw === 'object')
        this.index = new Map(
          Object.entries(raw as Record<string, unknown>).filter(
            (kv): kv is [string, Entry] => /^[0-9a-f]{40}$/.test(kv[0]) && isEntry(kv[1])
          )
        )
    } catch {
      this.index = new Map()
    }
    this.dropOrphans()
  }

  /**
   * Файлы звука, которых нет в списке (программу закрыли между записью файла и списка):
   * в лимит они не попадают и сами не удалятся, поэтому убираем их при запуске.
   */
  private dropOrphans(): void {
    try {
      for (const f of readdirSync(this.dir)) {
        const m = /^([0-9a-f]{40})[.]mp3$/.exec(f)
        if (m && !this.index.has(m[1] ?? '')) rmSync(join(this.dir, f), { force: true })
      }
    } catch {
      // папки нет или она недоступна: запись сообщит об этом сама
    }
  }

  get(key: string): { audio: Buffer; durationSec: number } | null {
    const e = this.index.get(key)
    if (!e) return null
    const file = join(this.dir, `${key}.mp3`)
    try {
      if (!existsSync(file)) {
        this.index.delete(key)
        return null
      }
      const audio = readFileSync(file)
      e.lastUsed = this.now()
      this.saveSoon()
      return { audio, durationSec: e.durationSec }
    } catch (err) {
      this.onError(text(err))
      return null
    }
  }

  /** Сохранить запись. Не бросает исключений: при сбое сообщает через onError. */
  put(key: string, audio: Buffer, durationSec: number): void {
    try {
      writeFileSync(join(this.dir, `${key}.mp3`), audio)
      this.index.set(key, { size: audio.length, durationSec, lastUsed: this.now() })
      this.evict()
      this.saveIndex()
    } catch (err) {
      this.onError(text(err))
    }
  }

  get totalBytes(): number {
    return [...this.index.values()].reduce((s, e) => s + e.size, 0)
  }

  /** Дописать отложенное на диск (перед выходом из программы). */
  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      this.saveIndex()
    } catch (err) {
      this.onError(text(err))
    }
  }

  /** Удалить самые давно использованные, пока не влезем в лимит. */
  private evict(): void {
    let total = this.totalBytes
    if (total <= this.maxBytes) return
    const byAge = [...this.index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [key, e] of byAge) {
      if (total <= this.maxBytes) break
      rmSync(join(this.dir, `${key}.mp3`), { force: true })
      this.index.delete(key)
      total -= e.size
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        this.saveIndex()
      } catch (err) {
        this.onError(text(err))
      }
    }, INDEX_SAVE_DELAY_MS)
    // Таймер не должен держать программу открытой.
    this.saveTimer.unref?.()
  }

  private saveIndex(): void {
    const tmp = join(this.dir, 'index.json.tmp')
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.index)))
    renameSync(tmp, join(this.dir, 'index.json'))
  }
}

/** Причина сбоя для человека. */
function text(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOSPC') return 'на диске кончилось место'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY')
    return 'файл занят другой программой или нет доступа к папке'
  return err instanceof Error ? err.message : String(err)
}
