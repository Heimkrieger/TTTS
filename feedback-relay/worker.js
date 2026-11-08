// Посредник для отзывов: программа шлёт сюда отчёт, посредник пересылает его автору в Telegram.
// Работает на Cloudflare Workers (бесплатный тариф). Ключ бота хранится здесь как секрет
// (TG_TOKEN), в коде программы его нет. Куда слать - секрет TG_CHAT_ID.
//
// Ничего не сохраняет и не записывает: ни отчёты, ни IP отправителя.

const MAX_BODY = 32 * 1024 // байт
const TG_TEXT_LIMIT = 4000 // у Telegram потолок 4096 символов на сообщение

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/report') {
      return json(404, { ok: false, error: 'not found' })
    }
    if (!env.TG_TOKEN || !env.TG_CHAT_ID) return json(500, { ok: false, error: 'not configured' })
    // Только JSON: браузер не может прислать такой запрос с чужого сайта без отдельного
    // разрешения (а его посредник не даёт), так что спам "из браузера" отсекается.
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
      return json(415, { ok: false, error: 'json only' })
    }
    // Защита от спама: по IP не чаще раза в минуту (если подключено ограничение Cloudflare).
    if (env.LIMITER) {
      const ip = request.headers.get('cf-connecting-ip') ?? 'none'
      const { success } = await env.LIMITER.limit({ key: ip })
      if (!success) return json(429, { ok: false, error: 'too many' })
    }
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY) return json(413, { ok: false, error: 'too large' })
    const raw = await request.text()
    if (new TextEncoder().encode(raw).length > MAX_BODY) {
      return json(413, { ok: false, error: 'too large' })
    }
    let r
    try {
      r = JSON.parse(raw)
    } catch {
      return json(400, { ok: false, error: 'bad json' })
    }
    if (typeof r !== 'object' || r === null) return json(400, { ok: false, error: 'bad json' })
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
    const kind = r.kind === 'idea' ? 'Идея' : 'Ошибка'
    const text = str(r.text, 4000).trim()
    if (text.length < 5) return json(400, { ok: false, error: 'empty' })

    const head = [
      `${kind} | версия ${str(r.appVersion, 30)} | ${str(r.os, 60)}`,
      r.contact ? `Связаться: ${str(r.contact, 200)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    const message = `${head}\n\n${text}`.slice(0, TG_TEXT_LIMIT)

    const sent = await tg(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: message })
    if (!sent) return json(502, { ok: false, error: 'telegram' })

    // Журнал - отдельным файлом, чтобы не упираться в длину сообщения.
    const log = str(r.log, 20000)
    if (log) {
      const form = new FormData()
      form.append('chat_id', env.TG_CHAT_ID)
      form.append('document', new Blob([log], { type: 'text/plain' }), 'journal.txt')
      const doc = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendDocument`, {
        method: 'POST',
        body: form
      })
      // Сообщение уже ушло, а журнал - нет: сообщаем программе.
      if (!doc.ok) return json(502, { ok: false, error: 'telegram log' })
    }
    return json(200, { ok: true })
  }
}

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.ok
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
