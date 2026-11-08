// Общие мелочи интерфейса: иконки, меню мьюта, форматирование времени.
import { useEffect, useRef, useState } from 'react'

const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  stop: 'M6 6h12v12H6z',
  skip: 'M5 5v14l9-7zM16 5h3v14h-3z',
  replay: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  up: 'M12 5l-7 7h4v7h6v-7h4z',
  close: 'M6 6l12 12M18 6L6 18',
  mute: 'M4 9v6h4l5 4V5L8 9H4zM16 9l5 6M21 9l-5 6',
  ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  chat: 'M4 5h16v11H8l-4 4z',
  filter: 'M3 5h18l-7 8v6l-4-2v-4z',
  check: 'M4 12l5 5L20 6',
  volume: 'M4 9v6h4l5 4V5L8 9H4zM16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a7 7 0 0 1 14 0v1M17 11a3 3 0 1 0 0-6M22 21v-1a5 5 0 0 0-4-5',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  key: 'M14 10a4 4 0 1 0-3.5 4H12v2h2v2h3v-3l-3.2-3.2A4 4 0 0 0 14 10z',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01',
  // Подарок: награда за баллы канала.
  gift: 'M4 9h16v4H4zM6 13v8h12v-8M12 9v12M12 9C10.5 6 7 5.5 7 7.5S10 9 12 9zm0 0c1.5-3 5-3.5 5-1.5S14 9 12 9z'
} as const

export type IconName = keyof typeof PATHS

/** Линейные иконки: заливка только у play/pause/stop/skip. */
const FILLED: IconName[] = ['play', 'pause', 'stop', 'skip', 'up']

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): React.JSX.Element {
  const filled = FILLED.includes(name)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

export function IconButton(props: {
  icon: IconName
  title: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** Включённое состояние (подсветка акцентом), например "награда озвучивается". */
  on?: boolean
}): React.JSX.Element {
  return (
    <button
      className={`icon-btn${props.danger ? ' danger' : ''}${props.on ? ' on' : ''}`}
      aria-pressed={props.on}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
    >
      <Icon name={props.icon} />
    </button>
  )
}

export const MUTE_OPTIONS: [number, string][] = [
  [5, '5 минут'],
  [15, '15 минут'],
  [60, '1 час'],
  [1440, '24 часа']
]

/** Кнопка мьюта с выбором срока. */
export function MuteButton({ login }: { login: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <IconButton icon="mute" title={`Мьют для ${login}`} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div className="menu">
          <div className="menu-title">Мьют {login} на</div>
          {MUTE_OPTIONS.map(([min, label]) => (
            <button
              key={min}
              onClick={() => {
                setOpen(false)
                void window.api.actions.mute(login, min)
              }}
            >
              {label}
            </button>
          ))}
          <button
            className="danger"
            onClick={() => {
              setOpen(false)
              void window.api.actions.blacklist(login, true)
            }}
          >
            Навсегда (чёрный список)
          </button>
        </div>
      )}
    </div>
  )
}

export const hhmmss = (ts: number): string =>
  new Date(ts).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

export const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** Текущее время, обновляется раз в intervalMs (для таймеров и прогресса). */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, active])
  return now
}

/** Тёмные цвета ников (синий, тёмно-красный) осветляем, чтобы читались на тёмном фоне. */
export function readableColor(hex: string | null): string | undefined {
  if (!hex) return undefined
  const n = parseInt(hex.slice(1), 16)
  let r = (n >> 16) & 255
  let g = (n >> 8) & 255
  let b = n & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if (lum >= 0.45) return hex
  const k = 0.55
  r = Math.round(r + (255 - r) * k)
  g = Math.round(g + (255 - g) * k)
  b = Math.round(b + (255 - b) * k)
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * Перелив по контуру "готовится к озвучке": отблеск с хвостом едет по самой рамке
 * с постоянной скоростью (длина пути нормирована pathLength=100), без рывков на углах.
 * Кладётся внутрь блока с классом ring-busy (у блока position: relative и скругление).
 */
export function BusyRing(): React.JSX.Element {
  return (
    <svg className="busy-ring" aria-hidden="true">
      <rect pathLength={100} />
    </svg>
  )
}
