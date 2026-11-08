import { describe, expect, it } from 'vitest'
import { filtersSchema, type FilterSettings } from '../src/shared/settings'
import {
  applyAntispam,
  compressLaughter,
  compressLetters,
  compressWords,
  compressSyllables
} from '../src/main/filters/antispam'
import { splitTags, stripInvisible } from '../src/main/filters/text'

const defaults = (): FilterSettings['antispam'] => filtersSchema.parse({}).antispam
const withCfg = (patch: Partial<FilterSettings['antispam']>): FilterSettings['antispam'] => ({
  ...defaults(),
  ...patch
})

// Реальные сообщения со стрима - как есть, с невидимым символом U+E0000 во втором.
const FIX1 =
  '[gasp], [gasp], [groan], [pant], (sighs), [gasp], [moan] [moan], [gasp], [groan], [pant], (sighs)'
const FIX2 =
  '[moan], [moan], [gasp], [groan], [pant], (sighs), *moans*, [moan] [moan], [gasp], [groan], [pant], (sighs), *ухухухуахахахахехехехмоанс*, [moan] \u{E0000}'
const FIX3 = 'брбрбрбрбрбрбрбрбрбрбрбрбр'

describe('правила букв', () => {
  it('одна буква больше 4 раз -> 3', () => {
    expect(compressLetters('аааааааа привет', false)).toBe('ааа привет')
    expect(compressLetters('аааа', false)).toBe('аааа')
  })
  it('без учёта регистра по умолчанию', () => {
    expect(compressLetters('АаАаАаА', false)).toBe('ААА')
    expect(compressLetters('АаАаАаА', true)).toBe('АаАаАаА')
  })
  it('повтор слога больше 3 раз -> 3', () => {
    expect(compressSyllables('блблблбл', false)).toBe('блблбл')
    expect(compressSyllables('блблбл', false)).toBe('блблбл')
    expect(compressSyllables(FIX3, false)).toBe('брбрбр')
    expect(compressSyllables('БрбРБрбр', false)).toBe('БрБрБр')
  })
  it('смех с чередованием слогов сжимается, слово после него остаётся', () => {
    expect(compressLaughter('ухухухуахахахахехехехмоанс')).toBe('ухухух моанс')
    expect(compressLaughter('ахахахахахахах')).toBe('ахахах')
    expect(compressLaughter('hahahahahahaha lol')).toBe('hahaha lol')
  })
  it('обычные слова смех не трогает', () => {
    for (const w of ['хохотать', 'абракадабра', 'хахаха', 'перевыполнение', 'аааааааа']) {
      expect(compressLaughter(w)).toBe(w)
    }
  })
})

describe('теги', () => {
  it('разбор тегов всех видов', () => {
    const tags = splitTags('[gasp] привет (sighs) <|speaker:0|> <whisper>тихо</whisper>')
      .filter((s) => s.type === 'tag')
      .map((s) => (s.type === 'tag' ? s.name : ''))
    expect(tags).toEqual(['gasp', 'sighs', 'speaker:0', 'whisper', 'whisper'])
  })
  it('длинные скобки - обычный текст', () => {
    expect(splitTags('(кстати я тут сижу давно)').every((s) => s.type === 'text')).toBe(true)
  })
  it('невидимые символы вырезаются', () => {
    expect(stripInvisible('привет\u{E0000}\u200B')).toBe('привет')
  })
})

describe('фикстуры со стрима, настройки по умолчанию', () => {
  it('1: одинаковые теги склеены, оставлены первые 3', () => {
    const r = applyAntispam(FIX1, defaults())
    expect(r).toEqual({ pass: true, text: '[gasp], [groan], [pant]' })
  })

  it('2: 3 тега, *moans* как есть, смех сжат, моанс цел', () => {
    const r = applyAntispam(stripInvisible(FIX2), defaults())
    expect(r.pass).toBe(true)
    if (r.pass) {
      expect(r.text).toBe('[moan], [gasp], [groan], *moans*, *ухухух моанс*')
      expect(r.text).not.toContain('\u{E0000}')
    }
  })

  it('3: брбр сжат', () => {
    expect(applyAntispam(FIX3, defaults())).toEqual({ pass: true, text: 'брбрбр' })
  })
})

describe('режимы переключателей', () => {
  it('выключено - текст не трогается', () => {
    const cfg = withCfg({ letterRepeat: 'off', syllableRepeat: 'off', laughter: 'off' })
    expect(applyAntispam(FIX3, cfg)).toEqual({ pass: true, text: FIX3 })
  })

  it('отклонять повтор слога', () => {
    const r = applyAntispam(FIX3, withCfg({ syllableRepeat: 'reject' }))
    expect(r).toEqual({ pass: false, reason: 'антиспам: повтор слога' })
  })

  it('порог: сжатие убрало 77% -> отказ в режиме "отклонять"', () => {
    const r = applyAntispam(FIX3, withCfg({ threshold: { mode: 'reject', percent: 40 } }))
    expect(r).toEqual({ pass: false, reason: 'антиспам: повторы заняли 77% текста' })
  })

  it('лимит тегов: отклонять', () => {
    const r = applyAntispam(FIX1, withCfg({ tagLimit: { mode: 'reject', max: 3 } }))
    expect(r.pass).toBe(false)
  })

  it('лимит тегов выключен, склейка дублей тоже - всё как есть', () => {
    const r = applyAntispam(FIX1, withCfg({ tagLimit: { mode: 'off', max: 3 }, dupTags: false }))
    expect(r).toEqual({ pass: true, text: FIX1 })
  })

  it('*действие* -> тег и считается в лимит', () => {
    const r = applyAntispam('*moans* привет', withCfg({ actions: 'tag' }))
    expect(r).toEqual({ pass: true, text: '[moans] привет' })
  })

  it('*действие* вырезать', () => {
    expect(applyAntispam('*moans* привет', withCfg({ actions: 'strip' }))).toEqual({
      pass: true,
      text: 'привет'
    })
  })

  it('только теги: разрешить и отклонить', () => {
    expect(applyAntispam('[gasp] [moan]', defaults()).pass).toBe(true)
    expect(applyAntispam('[gasp] [moan]', withCfg({ tagsOnly: 'reject' }))).toEqual({
      pass: false,
      reason: 'только теги без слов'
    })
  })

  it('теги не сжимаются правилами букв', () => {
    expect(applyAntispam('[aaaaaaa] ок', defaults())).toEqual({ pass: true, text: '[aaaaaaa] ок' })
  })
})

describe('повтор слов и фраз (живой чат)', () => {
  it('фраза из 5 слов 4 раза подряд -> 2 повтора', () => {
    const t = 'УМА УМА САМБА САМБА САМБА '.repeat(4).trim()
    expect(compressWords(t, false)).toBe('УМА УМА САМБА САМБА САМБА УМА УМА САМБА САМБА САМБА')
  })
  it('одиночные буквы через пробел', () => {
    expect(compressWords('ффф Ы Ы Ы Ы Ы Ы Ы', false)).toBe('ффф Ы Ы')
    expect(compressWords('эм эм эм эм.... эмм', false)).toBe('эм эм эмм')
  })
  it('3 повтора и обычный текст не трогаются', () => {
    expect(compressWords('нет нет нет', false)).toBe('нет нет нет')
    expect(compressWords('я сказал что я пришёл', false)).toBe('я сказал что я пришёл')
  })
  it('через antispam: правило выключается и отклоняет', () => {
    const t = 'Ы Ы Ы Ы Ы'
    expect(applyAntispam(t, withCfg({ wordRepeat: 'off' }))).toEqual({ pass: true, text: t })
    expect(applyAntispam(t, withCfg({ wordRepeat: 'reject' }))).toEqual({
      pass: false,
      reason: 'антиспам: повтор слов'
    })
  })
})

describe('крайние случаи', () => {
  it('"вырезать *действия*" не ломает "повтор слов: отклонять"', () => {
    const cfg = filtersSchema.parse({}).antispam
    cfg.actions = 'strip'
    cfg.wordRepeat = 'reject'
    expect(applyAntispam('привет *машет* как дела у вас', cfg)).toMatchObject({ pass: true })
  })
  it('длинные числа не считаются повтором слога', () => {
    expect(compressSyllables('заплатил 1000000000 рублей', false)).toBe(
      'заплатил 1000000000 рублей'
    )
    expect(compressSyllables('брбрбрбрбр', false)).toBe('брбрбр')
  })
})
