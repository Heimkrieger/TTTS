import { describe, expect, it } from 'vitest'
import { NICK_BG, contrast, defaultNickColor, nickColor } from '../src/shared/nickColor'

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]

describe('цвет ника', () => {
  it('светлый цвет не меняется', () => {
    expect(nickColor('#FF69B4', 'x')).toBe('#ff69b4')
  })
  it('тёмно-синий и чёрный высветляются до читаемых', () => {
    for (const c of ['#0000FF', '#000000', '#2E2E2E']) {
      expect(contrast(rgb(nickColor(c, 'x')), NICK_BG)).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('без цвета - стандартный цвет Twitch, всегда один и тот же для ника', () => {
    expect(defaultNickColor('vasya')).toBe(defaultNickColor('vasya'))
    expect(contrast(rgb(nickColor(null, 'vasya')), NICK_BG)).toBeGreaterThanOrEqual(4.5)
  })
})
