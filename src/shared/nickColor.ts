// Цвет ника как в чате Twitch, но читаемый на нашем тёмном фоне.
// Зритель выбирает цвет сам (часто тёмно-синий или чёрный), Twitch тоже подправляет такие цвета
// в тёмной теме. Без выбранного цвета Twitch назначает один из 15 стандартных по нику.

/** Стандартные цвета Twitch для тех, кто не выбрал свой. */
const DEFAULT_COLORS = [
  '#FF0000',
  '#0000FF',
  '#008000',
  '#B22222',
  '#FF7F50',
  '#9ACD32',
  '#FF4500',
  '#2E8B57',
  '#DAA520',
  '#D2691E',
  '#5F9EA0',
  '#1E90FF',
  '#FF69B4',
  '#8A2BE2',
  '#00FF7F'
]

/** Фон, на котором должен читаться ник (подложка сообщений для озвучки, светлее основного). */
const BG: [number, number, number] = [0x26, 0x26, 0x2b]
/** Минимальный контраст текста к фону (WCAG AA для обычного текста). */
const MIN_CONTRAST = 4.5

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const parse = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]
const toHex = (c: [number, number, number]): string =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** Стандартный цвет по нику: одинаковый для одного зрителя при каждом запуске. */
export function defaultNickColor(login: string): string {
  let h = 0
  for (const ch of login) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return DEFAULT_COLORS[h % DEFAULT_COLORS.length] ?? '#1E90FF'
}

/** Цвет ника для показа: свой цвет зрителя или стандартный, высветленный до читаемого. */
export function nickColor(color: string | null, login: string): string {
  const src = color && /^#[0-9a-f]{6}$/i.test(color) ? color : defaultNickColor(login)
  let c = parse(src)
  // Подмешиваем белый, пока контраст не станет достаточным: оттенок сохраняется.
  for (let i = 0; i < 20 && contrast(c, BG) < MIN_CONTRAST; i++) {
    c = c.map((v) => v + (255 - v) * 0.12) as [number, number, number]
  }
  return toHex(c)
}

export const NICK_BG = BG
