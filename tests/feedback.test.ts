import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FeedbackSender,
  MIN_INTERVAL_MS,
  buildReport,
  localTime,
  scrub
} from '../src/main/feedback'
import type { FeedbackReport } from '../src/shared/types'

describe('очистка отчёта от личных данных', () => {
  it('имя пользователя Windows в путях, короткие имена, IP, почта', () => {
    const t = scrub(
      'D:/x C:\\Users\\Ivan Petrov\\AppData C:/Users/ivan/x C:\\Users\\IVANPE~1\\Temp 192.168.1.5 a.b@mail.ru'
    )
    expect(t).not.toMatch(/Ivan|Petrov|ivan|IVANPE|192\.168|mail\.ru/)
    expect(t).toContain('C:\\Users\\<user>')
    expect(scrub('overlay: http://127.0.0.1:5190')).toBe('overlay: http://127.0.0.1:5190')
  })
  it('ключи и токены', () => {
    const key = 'a'.repeat(20) + 'B9'.repeat(8)
    const t = scrub(`Authorization: Bearer abc.def-123 token=xyz api_key: qwe ${key}`)
    expect(t).not.toMatch(/abc\.def|xyz|qwe|aaaaaaaa/)
  })
  it('обычный текст не портится', () => {
    expect(scrub('Озвучка зависла после смены голоса, версия 0.0.1')).toBe(
      'Озвучка зависла после смены голоса, версия 0.0.1'
    )
  })
  it('канал стримера скрыт и в тексте, и в журнале', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    const logFile = join(dir, 'main.log')
    writeFileSync(logFile, 'строка 1\nподключено к #Somechannel\nстрока 3\n')
    const r = buildReport(
      { kind: 'bug', text: 'на канале somechannel пропал звук', contact: '', attachLog: true },
      {
        appVersion: '0.0.1',
        os: 'Windows 10',
        logFile,
        channels: ['somechannel'],
        viewers: [],
        literals: []
      }
    )
    expect(r.text).toBe('на канале <channel> пропал звук')
    expect(r.log).toContain('#<channel>')
    expect(r.log).not.toMatch(/somechannel/i)
  })
  it('прежние каналы, ники зрителей, пути и имя компьютера; слово целиком', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-'))
    const logFile = join(dir, 'main.log')
    writeFileSync(
      logFile,
      [
        'Вход в канал oldchan',
        'Пропущено: vasya_228',
        String.raw`data=D:\Стримы Ивана\TwitchTTS\data`,
        'компьютер DESKTOP-IVAN',
        String.raw`путь \\nas\home\ivan.petrov\x`,
        String.raw`D:\ИВАНПЕ~1\Temp`,
        'канал chat открыт',
        'адрес fe80:0:0:0:1:2:3:4'
      ].join('\n')
    )
    const r = buildReport(
      { kind: 'bug', text: 'проблема', contact: '', attachLog: true },
      {
        appVersion: '0.0.1',
        os: 'Windows 10',
        logFile,
        channels: ['chat', 'oldchan'],
        viewers: ['vasya_228'],
        literals: [String.raw`D:\Стримы Ивана\TwitchTTS\data`, 'DESKTOP-IVAN']
      }
    )
    expect(r.log).not.toMatch(/oldchan|vasya_228|Ивана|DESKTOP-IVAN|nas|ivan\.petrov|ИВАНПЕ|fe80/)
    // Короткое имя канала заменяется только целым словом, а не внутри других слов.
    expect(r.log).toContain('канал <channel> открыт')
    expect(r.log).not.toContain('<channel>ter')
  })

  it('без галки журнал не прикладывается', () => {
    const r = buildReport(
      { kind: 'idea', text: 'добавить тёмную тему', contact: '@me', attachLog: false },
      {
        appVersion: '0.0.1',
        os: 'Windows 10',
        logFile: 'нет-файла',
        channels: [],
        viewers: [],
        literals: []
      }
    )
    expect(r.log).toBe('')
    expect(r.contact).toBe('@me')
  })
})

describe('отправка отзыва', () => {
  const report: FeedbackReport = {
    kind: 'bug',
    text: 'не работает звук',
    contact: '',
    appVersion: '0.0.1',
    os: 'Windows 10',
    sentAt: '08.11.2026 21:32 (UTC+3)',
    log: ''
  }

  it('время отправки: дата, время и пояс пользователя', () => {
    const t = localTime(new Date(2026, 10, 8, 21, 32).getTime())
    expect(t).toMatch(/^08\.11\.2026 21:32 \(UTC[+-]\d{1,2}(:\d{2})?\)$/)
  })

  it('адрес не задан - понятная причина, без отправки', async () => {
    const s = new FeedbackSender('', async () => ({ status: 200 }))
    const r = await s.send(report)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Скопировать')
  })

  it('не чаще раза в минуту; ошибки сервера и сети объясняются', async () => {
    let now = 1_000_000
    let status = 200
    let fail = false
    const sent: unknown[] = []
    const s = new FeedbackSender(
      'https://relay.example/report',
      async (_u, body) => {
        if (fail) throw new Error('offline')
        sent.push(body)
        return { status }
      },
      () => now
    )
    expect((await s.send(report)).ok).toBe(true)
    const again = await s.send(report)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toContain('Следующий можно через')
    now += MIN_INTERVAL_MS
    status = 500
    const e500 = await s.send(report)
    if (!e500.ok) expect(e500.error).toContain('500')
    fail = true
    const off = await s.send(report)
    if (!off.ok) expect(off.error).toContain('Нет связи')
    expect(sent).toEqual([report, report])
  })
})
