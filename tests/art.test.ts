import { describe, expect, it } from 'vitest'
import { artLines } from '../src/shared/art'

const row = (n: number): string => '⣿'.repeat(n)

describe('artLines', () => {
  it('рисунок из брайля делится на строки по пробелам', () => {
    const text = `${row(10)} ⠀${row(9)} ${row(10)}`
    expect(artLines(text)).toEqual([row(10), `⠀${row(9)}`, row(10)])
  })
  it('обычный текст и короткие смайлы - не рисунок', () => {
    expect(artLines('привет, как дела у всех')).toBeNull()
    expect(artLines('██ ok')).toBeNull()
  })
  it('одно слово без пробелов - не рисунок (ширину строки не узнать)', () => {
    expect(artLines(row(40))).toBeNull()
  })
  it('текст с парой символов рисунка - не рисунок', () => {
    expect(artLines(`${row(3)} это просто сообщение со значками ${row(3)}`)).toBeNull()
  })
})
