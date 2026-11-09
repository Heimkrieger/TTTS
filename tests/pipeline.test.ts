import { describe, expect, it } from 'vitest'
import { SETTINGS_VERSION, settingsSchema, type Settings } from '../src/shared/settings'
import type { ChatMessage } from '../src/shared/types'
import {
  commitFiltered,
  createFilterState,
  captionText,
  runFilters,
  speakableNick,
  type FilterContext,
  type FilterState
} from '../src/main/filters/pipeline'

const base = (): Settings => settingsSchema.parse({ version: SETTINGS_VERSION })

function msg(text: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: Math.random().toString(36),
    user: 'viewer',
    displayName: 'Viewer',
    text,
    badges: [],
    color: null,
    emotes: [],
    subMonths: null,
    reply: null,
    rewardId: null,
    isAction: false,
    timestamp: 0,
    ...patch
  }
}

const ctx = (patch: Partial<FilterContext> = {}): FilterContext => ({
  now: 1_000_000,
  queueLength: 0,
  isThirdPartyEmote: () => false,
  ...patch
})

function run(
  text: string,
  s: Settings = base(),
  opts: { m?: Partial<ChatMessage>; c?: Partial<FilterContext>; st?: FilterState } = {}
) {
  return runFilters(msg(text, opts.m), s, opts.st ?? createFilterState(), ctx(opts.c))
}

describe('пайплайн', () => {
  it('сообщение с префиксом проходит, префикс срезан', () => {
    expect(run('!!! привет чат')).toEqual({ pass: true, text: 'привет чат' })
  })

  it('без префикса - статус no-prefix, не отказ', () => {
    expect(run('привет')).toEqual({ pass: false, kind: 'no-prefix', reason: 'без префикса' })
  })

  it('префикс выключен - читается всё', () => {
    const s = base()
    s.filters.prefix.enabled = false
    expect(run('привет', s).pass).toBe(true)
  })

  it('озвучка выключена', () => {
    const s = base()
    s.tts.enabled = false
    expect(run('!!! привет', s)).toMatchObject({ pass: false, reason: 'озвучка выключена' })
  })

  it('чёрный список', () => {
    expect(run('!!! привет', base(), { m: { user: 'nightbot' } })).toMatchObject({
      pass: false,
      reason: 'ник в чёрном списке'
    })
  })

  it('роли: галочки, подходит любая; стример всегда', () => {
    const s = base()
    s.filters.roles = { ...s.filters.roles, everyone: false, subscribers: true, moderators: true }
    expect(run('!!! привет', s)).toMatchObject({
      pass: false,
      reason: 'озвучивают только: подписчики, модераторы'
    })
    expect(run('!!! привет', s, { m: { badges: ['vip'] } }).pass).toBe(false)
    expect(run('!!! привет', s, { m: { badges: ['subscriber'] } }).pass).toBe(true)
    expect(run('!!! привет', s, { m: { badges: ['moderator'] } }).pass).toBe(true)
    expect(run('!!! привет', s, { m: { badges: ['broadcaster'] } }).pass).toBe(true)
  })

  it('роли: фоловеры без входа в Twitch не проверяются, причина видна', () => {
    const s = base()
    s.filters.roles = { ...s.filters.roles, everyone: false, followers: true }
    expect(run('!!! привет', s)).toMatchObject({
      pass: false,
      reason: 'озвучивают только: фолловеры (фолловеров без входа в Twitch не проверить)'
    })
  })

  it('награда за баллы: отмеченная проходит без префикса, проверки как у префикса', () => {
    const s = base()
    s.filters.rewards = [{ id: 'r1', title: 'Озвучка' }]
    const reward = { m: { rewardId: 'r1' } }
    // Режим "префикс": награды не озвучиваются сами по себе.
    expect(run('привет', s, reward).pass).toBe(false)
    s.filters.trigger = 'both'
    expect(run('привет', s, reward)).toEqual({ pass: true, text: 'привет' })
    expect(run('!!! привет', s, reward)).toEqual({ pass: true, text: 'привет' })
    expect(run('!!! привет', s).pass).toBe(true) // префикс тоже работает
    s.filters.userCooldownSec = 60
    const st = createFilterState()
    st.lastByUser.set('viewer', 1_000_000)
    // Награда и префикс равноценны: кулдаун действует и на награду.
    expect(run('ещё раз', s, { ...reward, st }).pass).toBe(false)
    s.filters.trigger = 'reward'
    expect(run('!!! привет', s)).toMatchObject({ pass: false, reason: 'озвучка только за награду' })
    expect(run('привет', s, { m: { rewardId: 'другая' } })).toMatchObject({
      pass: false,
      reason: 'эта награда не отмечена для озвучки'
    })
  })

  it('повторы при "читать ник", "$&" в тексте, невидимые символы', () => {
    const s = base()
    s.tts.readNick.enabled = true
    const st = createFilterState()
    const a = run('!!! привет всем', s, { m: { user: 'a', displayName: 'A' }, st })
    expect(a.pass).toBe(true)
    if (a.pass) commitFiltered(msg('x', { user: 'a' }), a.dupText ?? a.text, st, 1_000_000, s)
    expect(run('!!! привет всем', s, { m: { user: 'b', displayName: 'B' }, st })).toMatchObject({
      pass: false
    })
    expect(run('!!! цена $& и $` тут', s, { m: { displayName: 'Vasya' } })).toMatchObject({
      text: 'Vasya пишет: цена $& и $` тут'
    })
    const sw = base()
    sw.filters.stopWords.list = ['плохое']
    const hidden = ['‎', '‭', '︀', 'ㅤ'].map((c) => JSON.parse(`"${c}"`) as string)
    for (const c of hidden) {
      expect(run(`!!! это пло${c}хое слово`, sw).pass).toBe(false)
    }
    expect(run(`!!! ${hidden[3]}${hidden[3]}${hidden[3]}`, base()).pass).toBe(false)
  })

  it('подпись на стриме: теги как в чате, без шаблона ника', () => {
    const s = base()
    expect(captionText('[excited] ура <whisper>тихо</whisper>', 'Vasya', s)).toBe(
      '[excited] ура <whisper>тихо</whisper>'
    )
    s.tts.readNick.enabled = true
    expect(captionText('Vasya пишет: [happy] привет', 'Vasya_228', s)).toBe('[happy] привет')
  })

  it('ник перед сообщением: по шаблону, ник очищен', () => {
    const s = base()
    s.tts.readNick.enabled = true
    expect(run('!!! привет', s, { m: { displayName: 'Vasya_228' } })).toMatchObject({
      pass: true,
      text: 'Vasya пишет: привет'
    })
    s.tts.readNick.template = '{текст}, сказал {ник}'
    expect(run('!!! привет', s, { m: { displayName: 'Петя' } })).toMatchObject({
      pass: true,
      text: 'привет, сказал Петя'
    })
    expect(speakableNick('xX_Kiiiller_Xx')).toBe('xX Killer Xx')
    expect(speakableNick('12345')).toBe('зритель')
  })

  it('ответ: "@ник" в начале убирается, префикс находится', () => {
    const reply = { user: 'petya', displayName: 'Петя', text: 'вопрос' }
    expect(run('@Петя !!! привет', base(), { m: { reply } })).toEqual({
      pass: true,
      text: 'привет'
    })
    expect(run('@petya !!! привет', base(), { m: { reply } })).toEqual({
      pass: true,
      text: 'привет'
    })
    expect(run('@Петя123 !!! привет', base(), { m: { reply } }).pass).toBe(false)
  })

  it('кулдаун: засчитывается только прошедшее сообщение', () => {
    const s = base()
    const st = createFilterState()
    // Отказ по длине кулдаун не запускает.
    expect(run('!!! а', s, { st }).pass).toBe(false)
    const ok = run('!!! привет', s, { st })
    expect(ok.pass).toBe(true)
    if (ok.pass) commitFiltered(msg('x'), ok.text, st, 1_000_000, s)
    expect(run('!!! ещё раз', s, { st, c: { now: 1_010_000 } })).toMatchObject({
      pass: false,
      reason: 'кулдаун: ещё 20 с'
    })
    expect(run('!!! ещё раз', s, { st, c: { now: 1_031_000 } }).pass).toBe(true)
  })

  it('ссылки вырезаются или отклоняются', () => {
    expect(run('!!! смотри https://example.com/x круто')).toEqual({
      pass: true,
      text: 'смотри круто'
    })
    expect(run('!!! заходи на сайт.рф друг')).toEqual({ pass: true, text: 'заходи на друг' })
    const s = base()
    s.filters.links = 'reject'
    expect(run('!!! www.test.ru', s)).toMatchObject({ pass: false, reason: 'ссылка в сообщении' })
  })

  it('эмоуты Twitch по диапазонам (в кодовых точках), сторонние по словам, эмодзи', () => {
    // "!!! 😀 Kappa привет KEKW": Kappa начинается с кодовой точки 6 (эмодзи - одна точка).
    const text = '!!! 😀 Kappa привет KEKW'
    const r = run(text, base(), {
      m: { emotes: [{ id: '25', start: 6, end: 10 }] },
      c: { isThirdPartyEmote: (w) => w === 'KEKW' }
    })
    expect(r).toEqual({ pass: true, text: 'привет' })
  })

  it('стоп-слова: отклонить и запикать, регулярки', () => {
    const s = base()
    s.filters.stopWords.list = ['плохое', '/ху[йе]\\w*/i']
    expect(run('!!! это плохое слово', s)).toMatchObject({
      pass: false,
      reason: 'стоп-слово: плохое'
    })
    expect(run('!!! неплохое слово', s).pass).toBe(true)
    s.filters.stopWords.mode = 'beep'
    expect(run('!!! это плохое слово', s)).toEqual({ pass: true, text: 'это пип слово' })
  })

  it('длина после чистки', () => {
    expect(run('!!! а')).toMatchObject({
      pass: false,
      reason: 'слишком коротко: 1 симв., минимум 2'
    })
    expect(run('!!! ' + Array.from({ length: 60 }, (_, i) => `слово${i}`).join(' '))).toMatchObject(
      { pass: false }
    )
    expect(run('!!! https://x.com')).toMatchObject({
      pass: false,
      reason: 'после чистки ничего не осталось'
    })
  })

  it('сообщение из одних тегов проходит длину', () => {
    expect(run('!!! [gasp] [moan]')).toEqual({ pass: true, text: '[gasp] [moan]' })
  })

  it('дубли: тот же текст от другого зрителя, в том числе с невидимым символом', () => {
    const s = base()
    const st = createFilterState()
    const a = run('!!! Привет всем', s, { st })
    if (a.pass) commitFiltered(msg('x'), a.text, st, 1_000_000, s)
    const b = run('!!! привет   всем\u{E0000}', s, {
      st,
      m: { user: 'other' },
      c: { now: 1_005_000 }
    })
    expect(b).toMatchObject({ pass: false, reason: 'повтор: такой же текст был 5 с назад' })
  })

  it('очередь заполнена', () => {
    expect(run('!!! привет', base(), { c: { queueLength: 100 } })).toMatchObject({
      pass: false,
      reason: 'очередь заполнена, в ней уже максимум (100)'
    })
  })

  it('фикстуры со стрима целиком через пайплайн', () => {
    const r = run(
      '!!! [moan], [moan], [gasp], [groan], [pant], (sighs), *moans*, [moan] [moan], [gasp], [groan], [pant], (sighs), *ухухухуахахахахехехехмоанс*, [moan] \u{E0000}'
    )
    expect(r).toEqual({ pass: true, text: '[moan], [gasp], [groan], *moans*, *ухухух моанс*' })
    expect(run('!!! брбрбрбрбрбрбрбрбрбрбрбрбр')).toEqual({ pass: true, text: 'брбрбр' })
  })
})

describe('стоп-слова стримера с тяжёлым выражением', () => {
  it('не подвешивают программу: сообщение пропускается с причиной', () => {
    // Объект настроек собираем мимо схемы: проверяем защиту при выполнении, а не при сохранении.
    const s = structuredClone(settingsSchema.parse({ version: SETTINGS_VERSION }))
    s.filters.prefix.enabled = false
    s.filters.antispam.letterRepeat = 'off'
    s.filters.antispam.syllableRepeat = 'off'
    s.filters.length.max = 5000
    s.filters.stopWords.list = ['/a*a*a*a*a*a*a*a*a*b/']
    const t0 = Date.now()
    const r = runFilters(msg('a'.repeat(300)), s, createFilterState(), {
      now: 0,
      queueLength: 0,
      isThirdPartyEmote: () => false
    })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r).toMatchObject({ pass: false })
    if (!r.pass) expect(r.reason).toContain('слишком долго')
    // Обычное выражение работает как раньше.
    s.filters.stopWords.list = ['/пло+хо/i']
    const hit = runFilters(msg('это ПЛОООХО'), s, createFilterState(), {
      now: 0,
      queueLength: 0,
      isThirdPartyEmote: () => false
    })
    expect(hit).toMatchObject({ pass: false, reason: 'стоп-слово: /пло+хо/i' })
  })
})

describe('несколько префиксов', () => {
  it('подходит любой, длинный проверяется первым, регистр не важен', () => {
    const s = base()
    s.filters.prefix.list = ['!', '!tts', '!!!']
    expect(run('!TTS привет', s)).toEqual({ pass: true, text: 'привет' })
    expect(run('!!! привет', s)).toEqual({ pass: true, text: 'привет' })
    expect(run('! привет', s)).toEqual({ pass: true, text: 'привет' })
    expect(run('привет', s).pass).toBe(false)
  })
  it('пустой список префиксов в настройках не сохраняется', () => {
    expect(
      settingsSchema.safeParse({ version: SETTINGS_VERSION, filters: { prefix: { list: [] } } })
        .success
    ).toBe(false)
  })
})
