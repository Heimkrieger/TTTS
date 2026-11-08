// Тест голоса: синтез фразы мимо очереди и проигрывание. Возвращает текст ошибки или null.
// onStart вызывается, когда синтез готов и звук пошёл (для смены "готовится" на "звучит").
import { playAudio } from './audio'

let testSeq = 1_000_000

export async function playTest(
  phrase: string,
  opts: { volume?: number; onStart?: () => void; voiceId?: string } = {}
): Promise<string | null> {
  const r = await window.api.fish.test(phrase, opts.voiceId)
  if (!r.ok) return r.error
  const vol = opts.volume ?? (await window.api.settings.get()).tts.volume
  opts.onStart?.()
  await playAudio(++testSeq, r.value.audio, vol, null)
  return null
}
