import { describe, expect, it } from 'vitest'
import { isRiskyRegex } from '../src/shared/regexSafety'
import { filtersSchema } from '../src/shared/settings'

describe('опасные регулярки в стоп-словах', () => {
  it('повтор внутри повтора и повтор вариантов - опасно', () => {
    for (const r of ['(а+)+б', '(\\w*)*$', '(a|aa)+', '(x+){2,}', '(?:ab+)*c']) {
      expect(isRiskyRegex(r)).toBe(true)
    }
  })
  it('обычные выражения - можно', () => {
    for (const r of ['пл[оа]хое', 'бл[яэ]+', '^спам', '(кот|пёс)', 'a+b+', '\\d{3,}']) {
      expect(isRiskyRegex(r)).toBe(false)
    }
  })
  it('настройки не принимают опасное стоп-слово и объясняют почему', () => {
    const r = filtersSchema.safeParse({ stopWords: { list: ['/(а+)+б/'] } })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toContain('подвесить программу')
    expect(
      filtersSchema.safeParse({ stopWords: { list: ['/пл[оа]хое/i', 'слово'] } }).success
    ).toBe(true)
  })
})
