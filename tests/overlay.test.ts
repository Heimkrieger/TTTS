import { request as httpRequest } from 'node:http'
// Локальная страница для OBS: отдаёт страницу и шрифты, звук идёт в источник, источник отвечает "доиграло".
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { OverlayServer } from '../src/main/overlay/server'
import { ObsNotConnectedError, ObsPlayer } from '../src/main/overlay/obsPlayer'

const silent = { info: () => {}, warn: () => {} }

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

/** Подключить "источник OBS" и собирать сообщения от программы. */
async function connect(port: number): Promise<{ ws: WebSocket; got: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const got: Record<string, unknown>[] = []
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as Record<string, unknown>))
  await new Promise((r) => ws.once('open', r))
  return { ws, got }
}
const until = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10))
}

let server: OverlayServer
let port: number
let warnings: string[]

beforeEach(async () => {
  port = await freePort()
  server = new OverlayServer(silent)
  warnings = []
  await server.start(port)
})
afterEach(async () => {
  await server.stop()
})

describe('страница для OBS', () => {
  it('отдаёт страницу и шрифт, только на 127.0.0.1', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<html')
    expect(html).toContain("new WebSocket('ws://' + location.host + '/ws')")
    const font = await fetch(`http://127.0.0.1:${port}/fonts/golos-500-cyr.woff2`)
    expect(font.status).toBe(200)
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    expect(server.status()).toMatchObject({
      running: true,
      clients: 0,
      url: `http://127.0.0.1:${port}/`
    })
  })

  it('порт занят - понятная причина, без падения', async () => {
    const other = new OverlayServer(silent)
    await other.start(port)
    expect(other.status().running).toBe(false)
    expect(other.status().error).toContain(`Порт ${port} занят`)
    await other.stop()
  })

  it('подпись "кто говорит" и настройка "показывать текст" доходят до источника', async () => {
    const { ws, got } = await connect(port)
    await until(() => server.clientCount === 1)
    server.caption({ nick: 'vasya', text: 'привет' })
    server.setShowText(false)
    await until(() => got.length >= 4)
    expect(got).toEqual([
      { type: 'config', showText: true },
      // При подключении - текущая подпись (пусто): старая не зависает на стриме.
      { type: 'caption', nick: null, text: '' },
      { type: 'caption', nick: 'vasya', text: 'привет' },
      { type: 'config', showText: false }
    ])
    ws.close()
  })

  it('чужой сайт не может подключиться; больше 4 источников - отказ', async () => {
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' })
    const refused = await new Promise<boolean>((r) => {
      foreign.once('open', () => r(false))
      foreign.once('error', () => r(true))
    })
    expect(refused).toBe(true)
    const own = await Promise.all([1, 2, 3, 4].map(() => connect(port).then((c) => c.ws)))
    await until(() => server.clientCount === 4)
    const fifth = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const fifthRefused = await new Promise<boolean>((r) => {
      fifth.once('open', () => r(false))
      fifth.once('error', () => r(true))
    })
    expect(fifthRefused).toBe(true)
    own.forEach((w) => w.close())
  })

  it('запрос с чужим адресом (подмена через DNS) - отказ', async () => {
    // fetch не даёт подменить Host, поэтому обычный http-запрос.
    const status = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/', headers: { Host: host } },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          }
        )
        req.on('error', reject)
        req.end()
      })
    expect(await status(`evil.example:${port}`)).toBe(403)
    expect(await status(`127.0.0.1:${port}`)).toBe(200)
  })
})

describe('проигрывание через OBS', () => {
  it('нет источника - очередь встанет на паузу с адресом для OBS', async () => {
    const p = new ObsPlayer(server, (t) => warnings.push(t))
    const e = await p
      .play({ audio: Buffer.from('mp3'), durationSec: 1, volume: 100, trimSec: null })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ObsNotConnectedError)
    expect((e as ObsNotConnectedError).fatal).toBe(true)
    expect((e as Error).message).toContain(`http://127.0.0.1:${port}/`)
  })

  it('звук уходит в источник, источник отвечает "доиграло"', async () => {
    const p = new ObsPlayer(server, (t) => warnings.push(t))
    const { ws, got } = await connect(port)
    await until(() => server.clientCount === 1)
    const done = p.play({
      audio: Buffer.from('mp3-data'),
      durationSec: 2,
      volume: 80,
      trimSec: null
    })
    await until(() => got.some((m) => m.type === 'play'))
    const play = got.find((m) => m.type === 'play')!
    expect(play).toMatchObject({ volume: 80, trimSec: null })
    expect(Buffer.from(String(play.audio), 'base64').toString()).toBe('mp3-data')
    ws.send(JSON.stringify({ type: 'ended', id: play.id, result: 'ended' }))
    expect(await done).toBe('ended')
    ws.close()
  })

  it('пропуск отправляет стоп с затуханием; источник отключился - ошибка с fatal, не зависаем', async () => {
    const p = new ObsPlayer(server, (t) => warnings.push(t))
    const { ws, got } = await connect(port)
    await until(() => server.clientCount === 1)
    const done = p.play({ audio: Buffer.from('x'), durationSec: 5, volume: 100, trimSec: null })
    await until(() => got.some((m) => m.type === 'play'))
    p.stop(150)
    await until(() => got.some((m) => m.type === 'stop'))
    expect(got.find((m) => m.type === 'stop')).toMatchObject({ fadeMs: 150 })
    ws.close()
    // Сообщение не теряется: очередь получит ошибку с fatal, вернёт его первым и встанет на паузу.
    await expect(done).rejects.toMatchObject({ fatal: true })
  })

  it('на паузе пропуск завершает сразу, не дожидаясь страницы', async () => {
    const p = new ObsPlayer(server, (t) => warnings.push(t))
    const { ws, got } = await connect(port)
    await until(() => server.clientCount === 1)
    const done = p.play({ audio: Buffer.from('x'), durationSec: 5, volume: 100, trimSec: null })
    await until(() => got.some((m) => m.type === 'play'))
    p.pause()
    p.stop(0)
    expect(await done).toBe('stopped')
    ws.close()
  })
})
