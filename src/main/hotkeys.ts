// Горячие клавиши: работают, даже когда в фокусе игра (globalShortcut Windows).
// Если сочетание занято другой программой - видно в окне и в журнале, а не молчит.
import type { HotkeyAction, HotkeyStatus } from '@shared/types'

export interface ShortcutApi {
  register(accelerator: string, cb: () => void): boolean
  unregisterAll(): void
}

export const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  skip: 'Пропустить текущее',
  pause: 'Пауза / продолжить',
  toggle: 'Озвучка вкл/выкл'
}

export class Hotkeys {
  private last = ''
  private statusValue: HotkeyStatus[] = []

  constructor(
    private readonly api: ShortcutApi,
    private readonly actions: Record<HotkeyAction, () => void>
  ) {}

  get status(): HotkeyStatus[] {
    return this.statusValue
  }

  /** Перерегистрировать по настройкам. Возвращает true, если что-то поменялось. */
  apply(cfg: Record<HotkeyAction, string>): boolean {
    const key = JSON.stringify(cfg)
    if (key === this.last) return false
    this.last = key
    this.api.unregisterAll()
    const used = new Map<string, HotkeyAction>()
    this.statusValue = (Object.keys(HOTKEY_LABEL) as HotkeyAction[]).map((action) => {
      const accel = cfg[action].trim()
      if (!accel) return { action, accelerator: '', ok: true, error: null }
      const dup = used.get(accel.toLowerCase())
      if (dup) {
        return {
          action,
          accelerator: accel,
          ok: false,
          error: `уже назначено на "${HOTKEY_LABEL[dup]}"`
        }
      }
      used.set(accel.toLowerCase(), action)
      try {
        const ok = this.api.register(accel, this.actions[action])
        return {
          action,
          accelerator: accel,
          ok,
          error: ok ? null : 'сочетание занято другой программой, выберите другое'
        }
      } catch {
        return {
          action,
          accelerator: accel,
          ok: false,
          error: 'Windows не принимает такое сочетание, выберите другое, например Ctrl+Shift+буква'
        }
      }
    })
    return true
  }

  stop(): void {
    this.api.unregisterAll()
  }
}
