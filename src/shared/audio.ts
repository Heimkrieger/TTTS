// Помощники для звука и горячих клавиш (без DOM и Electron, чтобы их можно было тестировать).

export interface OutputDevice {
  deviceId: string
  label: string
}

/**
 * Найти сохранённое устройство вывода. id у Chromium привязан к адресу страницы и может смениться
 * (например, разработка и собранная программа), поэтому при промахе ищем по имени.
 * null - устройство не найдено (отключено): звук пойдёт в устройство по умолчанию.
 */
export function pickDevice(
  devices: OutputDevice[],
  savedId: string,
  savedLabel: string
): OutputDevice | null {
  if (!savedId && !savedLabel) return { deviceId: '', label: 'как в Windows (по умолчанию)' }
  return (
    devices.find((d) => d.deviceId === savedId) ??
    (savedLabel ? devices.find((d) => d.label === savedLabel) : undefined) ??
    null
  )
}

/** Имя клавиши для Electron по KeyboardEvent.code. null - клавиша не подходит. */
export function keyName(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1] ?? null
  m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1] ?? null
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (m) return code
  m = /^Numpad([0-9])$/.exec(code)
  if (m) return `num${m[1]}`
  const map: Record<string, string> = {
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'Space',
    Insert: 'Insert',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Pause: 'Pause',
    ScrollLock: 'Scrolllock',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  }
  return map[code] ?? null
}

/**
 * Сочетание клавиш в формате Electron из нажатия: "Ctrl+Alt+S".
 * null - нажат только модификатор или неподходящая клавиша.
 * Без модификатора разрешены только F-клавиши, цифровой блок и Pause (иначе перехватим обычный ввод).
 */
export function accelerator(e: {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  const key = keyName(e.code)
  if (!key) return null
  const mods = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super'
  ].filter(Boolean) as string[]
  const standalone = /^F\d+$|^num|^Pause$|^Scrolllock$/.test(key)
  if (mods.length === 0 && !standalone) return null
  return [...mods, key].join('+')
}
