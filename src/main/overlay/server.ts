// Локальная страница для OBS (источник "Браузер"): http://127.0.0.1:<порт>/
// Отдаёт страницу и шрифты, держит WebSocket /ws: подпись "кто говорит" и (в режиме OBS) звук.
// Слушает только 127.0.0.1 - снаружи компьютера страница недоступна.
//
// Защита от чужих сайтов в браузере стримера: браузер разрешает любой странице подключиться к
// ws://127.0.0.1, поэтому проверяем заголовки Host и Origin (только наш адрес), ограничиваем
// число источников и частоту входящих сообщений. Иначе чужой сайт видел бы подписи и звук.
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import type { OverlayStatus } from '@shared/types'
import { overlayPage } from './page'

/** Сообщения из страницы. */
export type OverlayInbound =
  { type: 'hello' } | { type: 'ended'; id: number; result: 'ended' | 'stopped'; error?: string }

export interface OverlayEvents {
  status: [OverlayStatus]
  /** Страница сообщила, что звук доиграл или остановлен. */
  ended: [id: number, result: 'ended' | 'stopped', error: string | undefined]
}

/** Файлы шрифтов: путь в адресе -> модуль внутри @fontsource. */
const FONTS: Record<string, string> = {
  '/fonts/golos-500-cyr.woff2': '@fontsource/golos-text/files/golos-text-cyrillic-500-normal.woff2',
  '/fonts/golos-500-lat.woff2': '@fontsource/golos-text/files/golos-text-latin-500-normal.woff2',
  '/fonts/golos-600-cyr.woff2': '@fontsource/golos-text/files/golos-text-cyrillic-600-normal.woff2',
  '/fonts/golos-600-lat.woff2': '@fontsource/golos-text/files/golos-text-latin-600-normal.woff2'
}

/** Сколько источников OBS может быть подключено одновременно. */
export const MAX_CLIENTS = 4
/** Не больше стольких сообщений от страницы за 10 с (нормальная страница шлёт единицы). */
const MAX_INBOUND_PER_10S = 50

export class OverlayServer extends EventEmitter<OverlayEvents> {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private port = 0
  private error: string | null = null
  private showText = true
  private lastCaption: { nick: string; text: string } | null = null

  constructor(private readonly log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }) {
    super()
  }

  status(): OverlayStatus {
    return {
      url: `http://127.0.0.1:${this.port}/`,
      running: this.http !== null && this.error === null,
      clients: this.clients.size,
      error: this.error
    }
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** Адрес в запросе - наш (защита от подмены адреса через DNS). */
  private ownHost(host: string | undefined): boolean {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  /** Подключение от нашей страницы. Без Origin - не браузер (локальная программа), пускаем. */
  private ownOrigin(origin: string | undefined): boolean {
    return (
      origin === undefined ||
      origin === `http://127.0.0.1:${this.port}` ||
      origin === `http://localhost:${this.port}`
    )
  }

  /** Запуски идут строго по одному: два одновременных заняли бы порт друг у друга. */
  private starting: Promise<void> = Promise.resolve()

  /** Запустить (или перезапустить на другом порту). */
  start(port: number): Promise<void> {
    this.starting = this.starting.then(
      () => this.startNow(port),
      () => this.startNow(port)
    )
    return this.starting
  }

  private async startNow(port: number): Promise<void> {
    if (this.http && this.port === port && !this.error) return
    await this.stop()
    this.port = port
    this.error = null
    const http = createServer((req, res) => {
      if (!this.ownHost(req.headers.host)) {
        res.writeHead(403).end()
        return
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          // Страница не грузит ничего чужого и не может быть встроена в другой сайт.
          'Content-Security-Policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:*; media-src blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff'
        })
        res.end(overlayPage())
        return
      }
      const font = FONTS[path]
      if (font) {
        try {
          res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' })
          res.end(readFileSync(require.resolve(font)))
        } catch {
          res.writeHead(404).end()
        }
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
    http.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== '/ws') {
        socket.destroy()
        return
      }
      if (!this.ownHost(req.headers.host) || !this.ownOrigin(req.headers.origin)) {
        this.log.warn('overlay: отклонено подключение с чужой страницы')
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (this.clients.size >= MAX_CLIENTS) {
        this.log.warn(`overlay: отклонено подключение, уже ${MAX_CLIENTS} источника`)
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws))
    })
    await new Promise<void>((resolve) => {
      http.once('error', (e: NodeJS.ErrnoException) => {
        this.error =
          e.code === 'EADDRINUSE'
            ? `Порт ${port} занят другой программой. Укажите другой порт в разделе "Звук".`
            : 'Страница для OBS не запустилась. Перезапустите программу или смените порт в разделе "Звук".'
        this.log.warn('overlay:', this.error, e.code ?? '', e.message)
        resolve()
      })
      http.listen(port, '127.0.0.1', () => {
        this.log.info(`overlay: http://127.0.0.1:${port}/`)
        resolve()
      })
    })
    if (this.error) {
      http.close()
    } else {
      this.http = http
      this.wss = wss
    }
    this.emitStatus()
  }

  private onClient(ws: WebSocket): void {
    this.clients.add(ws)
    this.log.info(`overlay: подключился источник, всего ${this.clients.size}`)
    ws.send(JSON.stringify({ type: 'config', showText: this.showText }))
    // Всегда отправляем текущую подпись, в том числе "пусто": после перезапуска программы на стриме
    // не должна висеть старая подпись.
    ws.send(
      JSON.stringify({
        type: 'caption',
        nick: this.lastCaption?.nick ?? null,
        text: this.lastCaption?.text ?? ''
      })
    )
    let windowStart = Date.now()
    let count = 0
    ws.on('message', (data) => {
      const now = Date.now()
      if (now - windowStart > 10_000) {
        windowStart = now
        count = 0
      }
      if (++count > MAX_INBOUND_PER_10S) return
      let m: unknown
      try {
        m = JSON.parse(String(data))
      } catch {
        return
      }
      const o = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
      if (o.type === 'ended' && typeof o.id === 'number') {
        this.emit(
          'ended',
          o.id,
          o.result === 'stopped' ? 'stopped' : 'ended',
          typeof o.error === 'string' ? o.error.slice(0, 200) : undefined
        )
      }
    })
    ws.on('close', () => {
      this.clients.delete(ws)
      this.log.info(`overlay: источник отключился, осталось ${this.clients.size}`)
      this.emitStatus()
    })
    this.emitStatus()
  }

  /** Отправить всем открытым страницам. */
  send(msg: Record<string, unknown>): number {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) ws.send(data)
    return this.clients.size
  }

  /** Подпись "кто говорит": null - убрать. */
  caption(c: { nick: string; text: string } | null): void {
    const same = JSON.stringify(c) === JSON.stringify(this.lastCaption)
    this.lastCaption = c
    if (!same) this.send({ type: 'caption', nick: c?.nick ?? null, text: c?.text ?? '' })
  }

  setShowText(on: boolean): void {
    if (on === this.showText) return
    this.showText = on
    this.send({ type: 'config', showText: on })
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.terminate()
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    const http = this.http
    this.http = null
    if (http) await new Promise<void>((r) => http.close(() => r()))
  }
}
