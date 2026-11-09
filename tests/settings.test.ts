import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, migrate, type Encryptor, type Logger } from '../src/main/settings'
import { normalizeChannel } from '../src/shared/settings'

/** Заглушка шифрования: XOR + маркер, чтобы открытый текст не попадал в файл. */
function fakeEncryptor(available = true, machine = 'pc1'): Encryptor {
  return {
    isAvailable: () => available,
    encrypt: (plain) =>
      Buffer.from(
        `${machine}:` + Buffer.from(Buffer.from(plain).map((b) => b ^ 0x5a)).toString('hex')
      ),
    decrypt: (data) => {
      const [m, hex] = data.toString().split(':')
      if (m !== machine || !hex) throw new Error('не тот компьютер')
      return Buffer.from(Buffer.from(hex, 'hex').map((b) => b ^ 0x5a)).toString()
    }
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} }

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tts-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SettingsStore', () => {
  it('без файла - значения по умолчанию', () => {
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    const p = s.getPublic()
    expect(p.version).toBe(4)
    expect(p.twitch.channel).toBe('')
    expect(p.tts.model).toBe('s2.1-pro-free')
    expect(p.fishKey).toBe('none')
    expect(s.loadNotice).toBeNull()
  })

  it('настройки переживают перезапуск', () => {
    const a = new SettingsStore(file, fakeEncryptor(), silent)
    expect(a.update({ twitch: { channel: 'Artem_Stream' } }).ok).toBe(true)
    const b = new SettingsStore(file, fakeEncryptor(), silent)
    expect(b.getPublic().twitch.channel).toBe('artem_stream')
  })

  it('ссылка на канал приводится к логину', () => {
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    const r = s.update({ twitch: { channel: 'https://www.twitch.tv/SomeOne?ref=x' } })
    expect(r.ok && r.value.twitch.channel).toBe('someone')
  })

  it('неверный канал отклоняется с понятной причиной, файл не меняется', () => {
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    const r = s.update({ twitch: { channel: 'а б' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Имя канала')
    expect(s.getPublic().twitch.channel).toBe('')
  })

  it('renderer не может записать секреты или лишние поля', () => {
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s.update({ secrets: { fishApiKey: 'x' } }).ok).toBe(false)
    expect(s.update({ version: 5 }).ok).toBe(false)
    expect(s.update({ tts: { hack: 1 } }).ok).toBe(false)
  })

  it('ключ хранится зашифрованным и не виден в файле открытым текстом', () => {
    const key = 'fish-secret-key-1234567890'
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    const r = s.setFishKey(key)
    expect(r.ok && r.value.fishKey).toBe('ok')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(key)
    // В renderer уходит только статус.
    expect(JSON.stringify(s.getPublic())).not.toContain(key)
    expect(JSON.stringify(s.getPublic())).not.toContain('secrets')
    // После перезапуска ключ читается.
    const s2 = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s2.getFishKey()).toBe(key)
    expect(s2.getPublic().fishKey).toBe('ok')
  })

  it('без шифрования ОС ключ не сохраняется', () => {
    const s = new SettingsStore(file, fakeEncryptor(false), silent)
    const r = s.setFishKey('test0000key0000abc')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Шифрование Windows недоступно')
    expect(s.getPublic().fishKey).toBe('none')
  })

  it('пустой ключ отклоняется', () => {
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s.setFishKey('   ').ok).toBe(false)
  })

  it('папку перенесли на другой ПК - ключ "не читается", настройки целы', () => {
    const a = new SettingsStore(file, fakeEncryptor(true, 'pc1'), silent)
    a.update({ twitch: { channel: 'chan' } })
    a.setFishKey('test0000key0000abc')
    const b = new SettingsStore(file, fakeEncryptor(true, 'pc2'), silent)
    expect(b.getPublic().fishKey).toBe('unreadable')
    expect(b.getPublic().twitch.channel).toBe('chan')
    expect(b.getFishKey()).toBeNull()
  })

  it('удаление ключа', () => {
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    s.setFishKey('test0000key0000abc')
    expect(s.clearFishKey().fishKey).toBe('none')
    expect(new SettingsStore(file, fakeEncryptor(), silent).getFishKey()).toBeNull()
  })

  it('битый файл - копия, сброс и видимое предупреждение', () => {
    writeFileSync(file, '{ это не json')
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s.getPublic().twitch.channel).toBe('')
    expect(s.loadNotice).toContain('Файл настроек не прочитан')
    expect(readdirSync(dir).some((f) => f.startsWith('settings.broken-'))).toBe(true)
  })

  it('файл от более новой версии не перезаписывается молча', () => {
    writeFileSync(file, JSON.stringify({ version: 99 }))
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s.loadNotice).toContain('более новой версии')
    expect(readdirSync(dir).some((f) => f.startsWith('settings.broken-'))).toBe(true)
  })

  it('недостающие поля дополняются значениями по умолчанию', () => {
    writeFileSync(file, JSON.stringify({ version: 1, twitch: { channel: 'abc' } }))
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s.loadNotice).toBeNull()
    expect(s.getPublic().twitch.channel).toBe('abc')
    expect(s.getPublic().tts.enabled).toBe(true)
  })
})

describe('migrate', () => {
  it('файл без version считается версией 1 и доводится до текущей', () => {
    expect(migrate({ twitch: { channel: 'a' } }).version).toBe(4)
  })
  it('актуальная версия не меняется', () => {
    const raw = { version: 4, x: 1 }
    expect(migrate(raw)).toEqual(raw)
  })
  it('1 -> 2: старый одиночный префикс становится списком', () => {
    const out = migrate({ version: 1, filters: { prefix: { enabled: true, value: '!tts' } } })
    expect(out).toEqual({ version: 4, filters: { prefix: { enabled: true, list: ['!tts'] } } })
    expect(migrate({ version: 1 }).filters).toEqual({ prefix: { list: ['!!!'] } })
  })
  it('2 -> 3: уровень ролей становится галочками, мастер не показываем, если канал указан', () => {
    const out = migrate({ version: 2, twitch: { channel: 'abc' }, filters: { roles: 'vip' } })
    expect(out.filters).toEqual({
      roles: { everyone: false, followers: false, subscribers: false, vip: true, moderators: true }
    })
    expect(out.ui).toEqual({ wizardDone: true })
    const all = migrate({ version: 2, filters: { roles: 'all' } })
    expect(all.filters).toMatchObject({ roles: { everyone: true } })
    expect(all.ui).toBeUndefined()
  })
  it('3 -> 4: прежний лимит очереди 20 становится 100, свой лимит не трогаем', () => {
    expect(migrate({ version: 3, filters: { maxQueue: 20 } }).filters).toEqual({ maxQueue: 100 })
    expect(migrate({ version: 3, filters: { maxQueue: 50 } }).filters).toEqual({ maxQueue: 50 })
    expect(migrate({ version: 3 }).version).toBe(4)
  })
  it('файл версии 1 загружается без потерь (префикс перенесён)', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        twitch: { channel: 'abc' },
        filters: { prefix: { value: '??' } }
      })
    )
    const s = new SettingsStore(file, fakeEncryptor(), silent)
    expect(s.loadNotice).toBeNull()
    expect(s.getPublic().filters.prefix.list).toEqual(['??'])
    expect(s.getPublic().twitch.channel).toBe('abc')
  })
})

describe('normalizeChannel', () => {
  it.each([
    ['#Artem', 'artem'],
    ['twitch.tv/Artem', 'artem'],
    ['https://m.twitch.tv/artem/videos', 'artem'],
    ['  artem_1  ', 'artem_1']
  ])('%s -> %s', (input, out) => expect(normalizeChannel(input)).toBe(out))
})
