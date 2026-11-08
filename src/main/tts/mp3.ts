// Длительность MP3 подсчётом кадров. Точно и для постоянного, и для переменного битрейта.
// Вместо библиотеки music-metadata: она подключается только как ES-модуль и тянет
// за собой десяток пакетов ради одной цифры.

// Битрейт, кбит/с: [версия MPEG][слой][индекс]. Нас интересует Layer III.
const BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
}
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000] // MPEG 2.5
}

/** Длительность в секундах или null, если это не MP3. */
export function mp3Duration(buf: Uint8Array): number | null {
  let i = 0
  // Пропустить тег ID3v2 в начале.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 && buf.length > 10) {
    const size =
      ((buf[6] ?? 0) << 21) | ((buf[7] ?? 0) << 14) | ((buf[8] ?? 0) << 7) | (buf[9] ?? 0)
    i = 10 + size
  }
  let seconds = 0
  let frames = 0
  while (i + 4 <= buf.length) {
    const b1 = buf[i + 1] ?? 0
    if (buf[i] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      i++
      continue
    }
    const version = (b1 >> 3) & 3 // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b1 >> 1) & 3 // 1 = Layer III
    const b2 = buf[i + 2] ?? 0
    const brIdx = b2 >> 4
    const srIdx = (b2 >> 2) & 3
    const padding = (b2 >> 1) & 1
    const rates = SAMPLE_RATES[version]
    if (layer !== 1 || version === 1 || !rates || srIdx === 3 || brIdx === 0 || brIdx === 15) {
      i++
      continue
    }
    const sampleRate = rates[srIdx] as number
    const bitrate = ((version === 3 ? BITRATES.v1 : BITRATES.v2)[brIdx] as number) * 1000
    const samples = version === 3 ? 1152 : 576
    const frameLen = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding
    if (frameLen < 4) {
      i++
      continue
    }
    seconds += samples / sampleRate
    frames++
    i += frameLen
  }
  return frames > 0 ? seconds : null
}
