// Хранилище настроек: JSON-файл в папке данных, схема zod, миграции по полю version,
// секреты только в зашифрованном виде.
//
// Почему не electron-store: он работает только внутри Electron (не тестируется в Vitest)
// и с версии 10 подключается только как ES-модуль. Свой файл на 100 строк проще и прозрачнее.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  SETTINGS_VERSION,
  normalizeChannel,
  PATCHABLE_SECTIONS,
  settingsSchema,
  type PublicSettings,
  type SecretStatus,
  type Settings,
  type SettingsPatch
} from '@shared/settings'
import type { Result } from '@shared/types'

/** Шифрование секретов. В приложении - safeStorage (DPAPI Windows), в тестах - заглушка. */
export interface Encryptor {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

type RawSettings = Record<string, unknown> & { version?: unknown }

/** Миграции: ключ - версия, С КОТОРОЙ мигрируем. Каждая поднимает version на 1. */
const migrations: Record<number, (raw: RawSettings) => RawSettings> = {
  // 1 -> 2: один префикс (prefix.value) стал списком (prefix.list).
  1: (raw) => {
    const filters = isPlainObject(raw.filters) ? { ...raw.filters } : {}
    const prefix = isPlainObject(filters.prefix) ? { ...filters.prefix } : {}
    const old = typeof prefix.value === 'string' ? prefix.value.trim() : ''
    delete prefix.value
    if (!Array.isArray(prefix.list)) prefix.list = [old || '!!!']
    return { ...raw, version: 2, filters: { ...filters, prefix } }
  },
  // 2 -> 3: один уровень ролей стал галочками; у кого уже указан канал, мастер не показываем.
  2: (raw) => {
    const out: RawSettings = { ...raw, version: 3 }
    const filters = isPlainObject(raw.filters) ? { ...raw.filters } : null
    if (filters && typeof filters.roles === 'string') {
      const old = filters.roles
      filters.roles = {
        everyone: !['subscriber', 'vip', 'moderator'].includes(old),
        followers: false,
        subscribers: old === 'subscriber',
        vip: old === 'subscriber' || old === 'vip',
        moderators: old === 'subscriber' || old === 'vip' || old === 'moderator'
      }
      out.filters = filters
    }
    const channel = isPlainObject(raw.twitch) ? raw.twitch.channel : undefined
    if (typeof channel === 'string' && channel !== '') {
      out.ui = { ...(isPlainObject(raw.ui) ? raw.ui : {}), wizardDone: true }
    }
    return out
  },
  // 3 -> 4: прежний лимит очереди 20 оказался мал, по умолчанию стало 100.
  3: (raw) => {
    const filters = isPlainObject(raw.filters) ? { ...raw.filters } : null
    if (filters && filters.maxQueue === 20) filters.maxQueue = 100
    return filters ? { ...raw, version: 4, filters } : { ...raw, version: 4 }
  }
}

export function migrate(raw: RawSettings): RawSettings {
  let cur = raw
  let version = typeof cur.version === 'number' ? cur.version : 0
  // Версия 0: файл без поля version (не должен встречаться, но не падаем) - считаем версией 1.
  if (version === 0) {
    cur = { ...cur, version: 1 }
    version = 1
  }
  while (version < SETTINGS_VERSION) {
    const step = migrations[version]
    if (!step) throw new Error(`Нет миграции настроек с версии ${version}`)
    cur = step(cur)
    version = cur.version as number
  }
  return cur
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergeDeep<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = mergeDeep(out[k], v)
  }
  return out as T
}

export class SettingsStore {
  private data: Settings
  private fishKeyStatus: SecretStatus = 'none'
  /** Предупреждение, возникшее при загрузке (показывается в UI). */
  readonly loadNotice: string | null

  constructor(
    private readonly filePath: string,
    private readonly encryptor: Encryptor,
    private readonly log: Logger
  ) {
    const { data, notice } = this.load()
    this.data = data
    this.loadNotice = notice
    this.fishKeyStatus = this.computeSecretStatus(this.data.secrets.fishApiKey)
    if (notice) this.log.warn('settings:', notice)
  }

  private load(): { data: Settings; notice: string | null } {
    if (!existsSync(this.filePath)) {
      return { data: settingsSchema.parse({ version: SETTINGS_VERSION }), notice: null }
    }
    let reason: string
    // Причина для человека: технические подробности уходят только в журнал.
    let human = 'файл испорчен'
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!isPlainObject(raw)) throw new Error('файл испорчен')
      if (typeof raw.version === 'number' && raw.version > SETTINGS_VERSION) {
        human = 'файл от более новой версии программы'
        throw new Error(
          `файл от более новой версии программы (настройки v${raw.version}, программа понимает до v${SETTINGS_VERSION})`
        )
      }
      const parsed = settingsSchema.safeParse(migrate(raw))
      if (parsed.success) return { data: parsed.data, notice: null }
      reason = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    // Файл не читается: сохраняем копию, начинаем с настроек по умолчанию и говорим об этом.
    const backup = this.filePath.replace(/\.json$/, '') + `.broken-${Date.now()}.json`
    try {
      renameSync(this.filePath, backup)
    } catch (e) {
      this.log.error('settings: не удалось сохранить копию повреждённого файла', e)
    }
    this.log.error('settings: файл не прочитан:', reason)
    return {
      data: settingsSchema.parse({ version: SETTINGS_VERSION }),
      notice: `Файл настроек не прочитан: ${human}. Настройки сброшены, старый файл сохранён как ${backup}, подробности в журнале.`
    }
  }

  /** Запись через временный файл и переименование: при сбое питания не остаётся полуфайла. */
  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  private computeSecretStatus(enc: string | null): SecretStatus {
    if (enc === null) return 'none'
    try {
      this.encryptor.decrypt(Buffer.from(enc, 'base64'))
      return 'ok'
    } catch {
      return 'unreadable'
    }
  }

  /** Полные настройки для main-процесса (секреты в зашифрованном виде). Не изменять. */
  current(): Readonly<Settings> {
    return this.data
  }

  getPublic(): PublicSettings {
    const { secrets: _secrets, ...rest } = this.data
    return { ...structuredClone(rest), fishKey: this.fishKeyStatus }
  }

  /** Изменение настроек из renderer. Ввод проверяется схемой: renderer не доверяем. */
  update(patch: unknown): Result<PublicSettings> {
    const normalized = normalizePatch(patch)
    const unknownKey = findUnknownKey(normalized, this.data)
    if (unknownKey) return { ok: false, error: `Неизвестная настройка: ${unknownKey}` }
    const next = settingsSchema.safeParse(mergeDeep(this.data, normalized))
    if (!next.success) {
      return { ok: false, error: next.error.issues.map((i) => i.message).join('; ') }
    }
    this.data = next.data
    this.save()
    return { ok: true, value: this.getPublic() }
  }

  setFishKey(key: unknown): Result<PublicSettings> {
    if (typeof key !== 'string' || key.trim() === '') {
      return { ok: false, error: 'Ключ пустой. Скопируйте его на fish.audio в разделе API Keys.' }
    }
    // Ключ Fish - латиница, цифры, "-" и "_" без пробелов. Лишний перенос строки внутри ключа
    // ломал запросы, и ошибка выглядела как "нет связи".
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key.trim())) {
      return {
        ok: false,
        error:
          'Это не похоже на ключ Fish Audio: он состоит из латинских букв и цифр, без пробелов. Скопируйте его ещё раз на fish.audio в разделе API Keys.'
      }
    }
    if (!this.encryptor.isAvailable()) {
      return {
        ok: false,
        error:
          'Шифрование Windows недоступно, поэтому ключ не сохранён: хранить его открытым текстом небезопасно. ' +
          'Обычно так бывает, если программа запущена от другого пользователя Windows. Запустите её от своего.'
      }
    }
    const enc = this.encryptor.encrypt(key.trim()).toString('base64')
    this.data = { ...this.data, secrets: { ...this.data.secrets, fishApiKey: enc } }
    this.fishKeyStatus = 'ok'
    this.save()
    return { ok: true, value: this.getPublic() }
  }

  clearFishKey(): PublicSettings {
    this.data = { ...this.data, secrets: { ...this.data.secrets, fishApiKey: null } }
    this.fishKeyStatus = 'none'
    this.save()
    return this.getPublic()
  }

  /** Мьют зрителя до момента until (мс). Истёкшие мьюты заодно удаляются. */
  setMute(login: string, until: number, now: number): void {
    const mutes = this.data.mutes.filter((m) => m.login !== login && m.until > now)
    mutes.push({ login, until })
    this.data = { ...this.data, mutes }
    this.save()
  }

  removeMute(login: string): boolean {
    const before = this.data.mutes.length
    this.data = { ...this.data, mutes: this.data.mutes.filter((m) => m.login !== login) }
    this.save()
    return this.data.mutes.length !== before
  }

  /** Добавить или убрать ник из чёрного списка. */
  setBlacklisted(login: string, on: boolean): void {
    const list = this.data.filters.blacklist.filter((n) => n.toLowerCase() !== login)
    if (on) list.push(login)
    this.data = { ...this.data, filters: { ...this.data.filters, blacklist: list } }
    this.save()
  }

  /** Ключ Fish в открытом виде. Только для main-процесса (клиент Fish). */
  getFishKey(): string | null {
    const enc = this.data.secrets.fishApiKey
    if (enc === null) return null
    try {
      return this.encryptor.decrypt(Buffer.from(enc, 'base64'))
    } catch {
      this.fishKeyStatus = 'unreadable'
      return null
    }
  }
}

/** Приводим ввод к каноничному виду до проверки схемой (например, ссылку на канал - к логину). */
/**
 * Проверка, что renderer меняет только существующие настройки из разрешённых разделов.
 * Возвращает путь первого лишнего ключа или null. Массивы проверяются схемой целиком.
 */
function findUnknownKey(patch: unknown, current: unknown, path = ''): string | null {
  if (!isPlainObject(patch)) return path === '' ? '(не объект)' : null
  for (const [k, v] of Object.entries(patch)) {
    const p = path ? `${path}.${k}` : k
    if (path === '' && !(PATCHABLE_SECTIONS as readonly string[]).includes(k)) return p
    if (!isPlainObject(current) || !(k in current)) return p
    const cur = current[k]
    if (isPlainObject(v) && isPlainObject(cur)) {
      const bad = findUnknownKey(v, cur, p)
      if (bad) return bad
    }
  }
  return null
}

function normalizePatch(patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  const twitch = patch.twitch
  if (isPlainObject(twitch) && typeof twitch.channel === 'string') {
    return { ...patch, twitch: { ...twitch, channel: normalizeChannel(twitch.channel) } }
  }
  return patch
}

export type { SettingsPatch }
