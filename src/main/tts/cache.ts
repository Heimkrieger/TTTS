// Кэш синтезированного аудио: одинаковая фраза тем же голосом не синтезируется повторно (не тратит деньги).
// Ключ = sha1(текст + голос + модель + параметры). Файлы в <папка данных>/cache, LRU на 200 МБ.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CACHE_MAX_BYTES = 200 * 1024 * 1024

interface Entry {
  size: number
  durationSec: number
  lastUsed: number
}

export function cacheKey(parts: Record<string, string | number>): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex')
}

export class AudioCache {
  private index = new Map<string, Entry>()

  constructor(
    private readonly dir: string,
    private readonly maxBytes = CACHE_MAX_BYTES,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(dir, { recursive: true })
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
      // Ключ - sha1 (40 шестнадцатеричных знаков): по нему строится имя файла, чужое не пускаем.
      if (raw && typeof raw === 'object')
        this.index = new Map(
          Object.entries(raw as Record<string, Entry>).filter(([k]) => /^[0-9a-f]{40}$/.test(k))
        )
    } catch {
      this.index = new Map()
    }
  }

  get(key: string): { audio: Buffer; durationSec: number } | null {
    const e = this.index.get(key)
    if (!e) return null
    const file = join(this.dir, `${key}.mp3`)
    if (!existsSync(file)) {
      this.index.delete(key)
      return null
    }
    e.lastUsed = this.now()
    this.saveIndex()
    return { audio: readFileSync(file), durationSec: e.durationSec }
  }

  put(key: string, audio: Buffer, durationSec: number): void {
    writeFileSync(join(this.dir, `${key}.mp3`), audio)
    this.index.set(key, { size: audio.length, durationSec, lastUsed: this.now() })
    this.evict()
    this.saveIndex()
  }

  get totalBytes(): number {
    return [...this.index.values()].reduce((s, e) => s + e.size, 0)
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

  private saveIndex(): void {
    const tmp = join(this.dir, 'index.json.tmp')
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.index)))
    renameSync(tmp, join(this.dir, 'index.json'))
  }
}
