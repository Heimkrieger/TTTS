import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveDataDir, type DataDirInput } from '../src/main/paths'

const base: DataDirInput = {
  isPackaged: true,
  appPath: 'C:\\repo',
  exePath: 'D:\\Apps\\TTS\\TwitchTTS.exe',
  portableDir: undefined,
  appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
  appName: 'TwitchTTS',
  canWrite: () => true
}

describe('resolveDataDir', () => {
  it('в разработке - .devdata в репозитории', () => {
    const r = resolveDataDir({ ...base, isPackaged: false })
    expect(r).toEqual({ dir: join('C:\\repo', '.devdata'), mode: 'dev', notice: null })
  })

  it('портативно - data рядом с exe', () => {
    const r = resolveDataDir(base)
    expect(r.dir).toBe(join('D:\\Apps\\TTS', 'data'))
    expect(r.mode).toBe('portable')
    expect(r.notice).toBeNull()
  })

  it('PORTABLE_EXECUTABLE_DIR важнее пути exe', () => {
    const r = resolveDataDir({ ...base, portableDir: 'E:\\Stream\\TTS' })
    expect(r.dir).toBe(join('E:\\Stream\\TTS', 'data'))
  })

  it('нет прав на запись - запасная папка и понятная причина', () => {
    const r = resolveDataDir({ ...base, canWrite: () => false })
    expect(r.mode).toBe('fallback')
    expect(r.dir).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'TwitchTTS'))
    expect(r.notice).toContain('нельзя записывать')
    expect(r.notice).toContain('D:\\Apps\\TTS')
  })
})
