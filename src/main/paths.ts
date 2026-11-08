// Где лежат данные приложения (настройки, логи, кэш).
// Портативный режим: папка data\ рядом с exe. Если туда писать нельзя - %APPDATA%\<имя> с видимой причиной.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DataMode } from '@shared/ipc'

export interface DataDirInput {
  isPackaged: boolean
  /** app.getAppPath(): в dev это корень репозитория. */
  appPath: string
  /** process.execPath: путь к exe. */
  exePath: string
  /** PORTABLE_EXECUTABLE_DIR от electron-builder (цель portable), если есть. */
  portableDir: string | undefined
  /** app.getPath('appData'). */
  appDataDir: string
  appName: string
  /** Можно ли создать папку и записать в неё файл. */
  canWrite: (dir: string) => boolean
}

export interface DataDir {
  dir: string
  mode: DataMode
  notice: string | null
}

/** Чистая функция выбора папки данных: без обращения к Electron, чтобы её можно было тестировать. */
export function resolveDataDir(input: DataDirInput): DataDir {
  if (!input.isPackaged) {
    return { dir: join(input.appPath, '.devdata'), mode: 'dev', notice: null }
  }
  const exeDir = input.portableDir ?? dirname(input.exePath)
  const portable = join(exeDir, 'data')
  if (input.canWrite(portable)) {
    return { dir: portable, mode: 'portable', notice: null }
  }
  const fallback = join(input.appDataDir, input.appName)
  return {
    dir: fallback,
    mode: 'fallback',
    notice:
      `В папку программы нельзя записывать (${exeDir}), поэтому настройки и журнал лежат в ${fallback}. ` +
      'Чтобы всё хранилось рядом с программой, распакуйте её в обычную папку, например на рабочий стол или в D:\\Программы.'
  }
}

/** Проверка записи: создаём папку и пробный файл, потом удаляем файл. */
export function canWriteDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe)
    return true
  } catch {
    return false
  }
}
