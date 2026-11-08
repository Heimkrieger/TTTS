// Раздел "Звук" (верхняя часть): скорость, громкость, пауза между сообщениями, лимит длительности.
// Голос и модель - в разделе "Голос", устройство вывода - ниже, в AudioPanel.
import type { PublicSettings, SettingsPatch } from '@shared/settings'
import { NumberField, Segmented, TextField, Toggle } from './controls'

export function SoundPanel({
  s,
  set
}: {
  s: PublicSettings
  set: (p: SettingsPatch) => void
}): React.JSX.Element {
  const t = s.tts
  return (
    <div className="page">
      <section className="group">
        <h3>Скорость и громкость</h3>
        <NumberField
          label="Скорость речи"
          value={Math.round(t.speed * 100)}
          min={50}
          max={200}
          suffix="% (100 - обычная)"
          onChange={(v) => set({ tts: { speed: v / 100 } })}
        />
        <NumberField
          label="Громкость"
          value={t.volume}
          min={0}
          max={200}
          suffix="%"
          onChange={(v) => set({ tts: { volume: v } })}
        />
        <NumberField
          label="Пауза между сообщениями"
          value={t.pauseBetweenMs / 1000}
          min={0}
          max={10}
          decimals={1}
          suffix="с"
          onChange={(v) => set({ tts: { pauseBetweenMs: Math.round(v * 1000) } })}
        />
      </section>
      <section className="group">
        <h3>Ник</h3>
        <Toggle
          label="Читать ник перед сообщением"
          value={t.readNick.enabled}
          onChange={(v) => set({ tts: { readNick: { enabled: v } } })}
          hint='цифры, "_" и повторы букв из ника не читаются: "Vasya_228" прозвучит как "Vasya"'
        />
        {t.readNick.enabled && (
          <>
            <TextField
              label="Шаблон"
              value={t.readNick.template}
              placeholder="{ник} пишет: {текст}"
              onChange={(v) => set({ tts: { readNick: { template: v } } })}
            />
            <p className="muted small">
              {'{ник}'} - имя зрителя, {'{текст}'} - его сообщение. Пример: "
              {t.readNick.template
                .replaceAll('{ник}', 'Vasya')
                .replaceAll('{текст}', 'привет всем')}
              ".
            </p>
          </>
        )}
      </section>
      <section className="group">
        <h3>Длинные сообщения</h3>
        <NumberField
          label="Лимит длительности"
          value={t.maxDurationSec}
          min={3}
          max={600}
          suffix="с"
          onChange={(v) => set({ tts: { maxDurationSec: v } })}
        />
        <Segmented
          label="Если длиннее лимита"
          value={t.overLimit}
          options={[
            ['skip', 'пропустить'],
            ['trim', 'обрезать по лимиту']
          ]}
          onChange={(v) => set({ tts: { overLimit: v } })}
          hint="при пропуске слишком длинные сообщения не отправляются в Fish и денег не тратят"
        />
      </section>
    </div>
  )
}
