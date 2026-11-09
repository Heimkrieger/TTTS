// Подставной Fish для проверки нагрузки (только разработка, TTS_FAKE_FISH=1).
// Вместо сети отдаёт готовый mp3 с задержкой как у настоящего сервера, иногда отвечает
// "перегружен", чтобы проверялись повторы. Баланс и деньги не тратятся.
import { readFileSync } from 'node:fs'

export function fakeFishFetch(mp3File: string): typeof fetch {
  const mp3 = readFileSync(mp3File)
  let n = 0
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/v1/tts')) {
      n++
      await new Promise((r) => setTimeout(r, 300 + ((n * 137) % 900)))
      if (n % 20 === 0) return json({ message: 'overloaded' }, 503)
      return new Response(new Uint8Array(mp3), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
      })
    }
    if (url.includes('/wallet/')) return json({ credit: '10.00' })
    if (url.includes('/model?')) return json({ items: [] })
    return json({ message: 'not found' }, 404)
  }
}
