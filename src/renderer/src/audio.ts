// Проигрывание звука в окне (Web Audio).
//
// Два выхода:
// - основной: выбранное устройство (например, VB-Cable для OBS), громкость "Громкость";
// - монитор (по желанию): второе устройство (наушники стримера) со своей громкостью.
// Цепочка: звук -> затухание сообщения -> [компрессор] -> громкость выхода -> устройство.
import { pickDevice, type OutputDevice } from '@shared/audio'

interface Output {
  ctx: AudioContext
  /** Компрессор или прямой проход (включается/выключается переподключением). */
  input: GainNode
  comp: DynamicsCompressorNode
  master: GainNode
  /** Какое устройство сейчас реально выбрано ('' - по умолчанию). */
  sinkId: string
}

export interface AudioConfig {
  deviceId: string
  deviceLabel: string
  monitor: { enabled: boolean; deviceId: string; deviceLabel: string; volume: number }
  compressor: boolean
}

/** Сообщение о проблеме со звуком (устройство пропало и т.п.) - уходит в журнал. */
let onProblem: (text: string) => void = () => {}
export function setProblemHandler(fn: (text: string) => void): void {
  onProblem = fn
}

let main: Output | null = null
let monitor: Output | null = null
let config: AudioConfig | null = null
let volume = 1
let lastProblem = ''

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

function makeOutput(): Output {
  const ctx = new AudioContext()
  const input = ctx.createGain()
  const comp = ctx.createDynamicsCompressor()
  // Мягкий компрессор для голоса: громкое прижимается, тихое не трогается.
  comp.threshold.value = -18
  comp.knee.value = 12
  comp.ratio.value = 4
  comp.attack.value = 0.005
  comp.release.value = 0.2
  const master = ctx.createGain()
  master.connect(ctx.destination)
  return { ctx, input, comp, master, sinkId: '' }
}

function wire(o: Output, compressor: boolean): void {
  o.input.disconnect()
  o.comp.disconnect()
  if (compressor) {
    o.input.connect(o.comp)
    o.comp.connect(o.master)
  } else o.input.connect(o.master)
}

function problem(text: string): void {
  if (text === lastProblem) return
  lastProblem = text
  onProblem(text)
}

/** Список устройств вывода. */
export async function listOutputs(): Promise<OutputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter(
      (d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
    )
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'устройство без имени' }))
}

async function applySink(
  o: Output,
  savedId: string,
  savedLabel: string,
  what: string
): Promise<void> {
  const devices = await listOutputs()
  const dev = pickDevice(devices, savedId, savedLabel)
  const target = dev?.deviceId ?? ''
  if (!dev)
    problem(
      `${what}: устройство "${savedLabel || savedId}" не найдено, звук идёт в устройство Windows по умолчанию. Подключите устройство или выберите другое в разделе "Звук".`
    )
  if (o.sinkId === target) return
  const c = o.ctx as SinkContext
  if (!c.setSinkId) {
    problem(
      'Не удалось выбрать устройство вывода, звук идёт в устройство Windows по умолчанию. Перезапустите программу. Если повторится, отправьте отчёт через "Сообщить о проблеме".'
    )
    return
  }
  try {
    await c.setSinkId(target)
    o.sinkId = target
    if (dev) lastProblem = ''
  } catch (e) {
    problem(
      `${what}: не удалось переключиться на "${dev?.label ?? target}". Выберите устройство заново в разделе "Звук". Подробности для отчёта: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/** Применить настройки вывода (вызывается при запуске и при каждом изменении). */
export async function configure(c: AudioConfig): Promise<void> {
  config = c
  if (!main) main = makeOutput()
  wire(main, c.compressor)
  await applySink(main, c.deviceId, c.deviceLabel, 'Основной выход')
  if (c.monitor.enabled) {
    if (!monitor) monitor = makeOutput()
    wire(monitor, c.compressor)
    monitor.master.gain.value = c.monitor.volume / 100
    await applySink(monitor, c.monitor.deviceId, c.monitor.deviceLabel, 'Наушники для себя')
  } else if (monitor) {
    await monitor.ctx.close()
    monitor = null
  }
}

/** Устройство подключили или отключили: переприменить выбор. */
navigator.mediaDevices?.addEventListener('devicechange', () => {
  if (config) void configure(config)
})

interface Playing {
  id: number
  sources: AudioBufferSourceNode[]
  fades: GainNode[]
  stopped: boolean
}
/** Всё, что играет сейчас. Обычно одно сообщение, но проверка голоса может звучать поверх. */
const playing = new Map<number, Playing>()
/** Пропуск пришёл, пока звук ещё готовился (декодировался): остановим сразу после. */
const stopRequested = new Set<number>()

async function startOn(
  o: Output,
  data: Uint8Array,
  trimSec: number | null
): Promise<{ src: AudioBufferSourceNode; fade: GainNode; duration: number }> {
  if (o.ctx.state === 'suspended') await o.ctx.resume()
  // decodeAudioData забирает буфер себе: даём копию.
  const buf = await o.ctx.decodeAudioData(data.slice().buffer)
  const src = o.ctx.createBufferSource()
  src.buffer = buf
  const fade = o.ctx.createGain()
  src.connect(fade).connect(o.input)
  const t = o.ctx.currentTime
  if (trimSec !== null && trimSec < buf.duration) {
    // Обрезка по лимиту: плавное затухание за последние 0.3 с.
    fade.gain.setValueAtTime(1, Math.max(t, t + trimSec - 0.3))
    fade.gain.linearRampToValueAtTime(0, t + trimSec)
    src.start(t, 0, trimSec)
  } else src.start(t)
  return { src, fade, duration: buf.duration }
}

/** Проиграть mp3 на основном выходе (и мониторе). 'ended' - доиграло, 'stopped' - пропуск. */
export async function playAudio(
  id: number,
  data: Uint8Array,
  vol: number,
  trimSec: number | null
): Promise<'ended' | 'stopped'> {
  if (!main) main = makeOutput()
  setVolume(vol)
  // Основной выход обязан заиграть. Сбой второго ("в наушники") сообщение не отменяет: иначе
  // очередь пошла бы дальше, а основной выход продолжал бы играть это же сообщение.
  const [mainRes, monRes] = await Promise.allSettled([
    startOn(main, data, trimSec),
    monitor ? startOn(monitor, data, trimSec) : Promise.resolve(null)
  ])
  if (mainRes.status === 'rejected') {
    if (monRes.status === 'fulfilled' && monRes.value) monRes.value.src.stop()
    throw mainRes.reason
  }
  const started = [mainRes.value]
  if (monRes.status === 'fulfilled' && monRes.value) started.push(monRes.value)
  else if (monRes.status === 'rejected')
    problem(
      `Наушники для себя: звук не проигрался, основной выход работает. Выберите устройство заново в разделе "Звук". Подробности для отчёта: ${String(monRes.reason)}`
    )
  const me: Playing = {
    id,
    sources: started.map((s) => s.src),
    fades: started.map((s) => s.fade),
    stopped: false
  }
  playing.set(id, me)
  if (stopRequested.delete(id)) {
    me.stopped = true
    me.sources.forEach((src) => src.stop())
  }
  return new Promise((resolve) => {
    mainRes.value.src.onended = () => {
      playing.delete(id)
      resolve(me.stopped ? 'stopped' : 'ended')
    }
  })
}

/** Остановить с быстрым затуханием (без щелчка). */
export function stopAudio(id: number | null, fadeMs: number): void {
  const one = id === null ? undefined : playing.get(id)
  const targets = id === null ? [...playing.values()] : one ? [one] : []
  if (targets.length === 0) {
    // Этот звук ещё готовится: запоминаем, чтобы не проиграть его целиком после пропуска.
    if (id !== null) {
      if (stopRequested.size > 50) stopRequested.clear()
      stopRequested.add(id)
    }
    return
  }
  for (const c of targets) {
    c.stopped = true
    c.sources.forEach((src, i) => {
      const fade = c.fades[i]
      const t = src.context.currentTime
      if (fade) {
        fade.gain.cancelScheduledValues(t)
        fade.gain.setValueAtTime(fade.gain.value, t)
        fade.gain.linearRampToValueAtTime(0, t + fadeMs / 1000)
      }
      src.stop(t + fadeMs / 1000)
    })
  }
}

export function pauseAudio(): void {
  void main?.ctx.suspend()
  void monitor?.ctx.suspend()
}

export function resumeAudio(): void {
  void main?.ctx.resume()
  void monitor?.ctx.resume()
}

/** Громкость основного выхода в процентах (0-200). */
export function setVolume(percent: number): void {
  volume = Math.max(0, Math.min(2, percent / 100))
  if (main) main.master.gain.setValueAtTime(volume, main.ctx.currentTime)
}
