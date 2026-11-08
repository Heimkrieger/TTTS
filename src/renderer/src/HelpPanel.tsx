// Раздел "Справка": как работают теги эмоций, полный список с переводом и кнопкой "послушать",
// и готовая шпаргалка для зрителей.
import { useState } from 'react'
import type { PublicSettings } from '@shared/settings'
import { playTest } from './playTest'
import { TAG_COMBOS, TAG_GROUPS, type TagInfo } from './tagsHelp'
import { BusyRing, Icon } from './ui'

/** Модели в таблице "что где работает" (порядок колонок). */
const MODELS: { id: string; price: string }[] = [
  { id: 's2.1-pro-free', price: 'бесплатно' },
  { id: 's2.1-pro', price: '$15 за 1 млн байт' },
  { id: 's2-pro', price: '$15 за 1 млн байт' },
  { id: 'drama-3', price: '$50 за 1 млн байт' }
]

/** Возможности по моделям, в порядке MODELS. Источник: документация Fish, emotions и drama-3. */
const FEATURES: { title: string; on: boolean[] }[] = [
  { title: 'Теги из списка ниже: эмоции, тон, звуки, паузы', on: [true, true, true, true] },
  { title: 'Свои описания по-английски: [warm and happy]', on: [true, true, true, true] },
  { title: 'Несколько тегов подряд и усилители (very, slightly)', on: [true, true, true, true] },
  { title: 'Парные теги: <whisper>текст</whisper>', on: [false, false, false, true] }
]

/**
 * Шпаргалка для чата: до 500 символов (лимит сообщения Twitch).
 * maxTags - лимит тегов из фильтров; null - лимит выключен, фраза про него не пишется.
 */
export function viewerCheatSheet(
  prefix: string,
  prefixOn: boolean,
  maxTags: number | null
): string {
  const start = prefixOn && prefix ? `Начни сообщение с ${prefix}` : 'Просто напиши в чат'
  const limit = maxTags !== null ? ` Скобок с эмоцией в одном сообщении: не больше ${maxTags}.` : ''
  return (
    `Озвучка: ${start}. Эмоции пишутся в квадратных скобках по-английски перед фразой: ` +
    `[laughing] смех, [whispering] шёпот, [shouting] крик, [sighing] вздох, [sad] грусть, [excited] восторг. ` +
    `Пример: ${prefixOn && prefix ? `${prefix} ` : ''}[excited] я выиграл.${limit}`
  )
}

/** Состояние примера: готовится (перелив по контуру) или звучит (ровная рамка). */
type Phase = 'loading' | 'playing'

function TagChip({
  info,
  phase,
  onPlay
}: {
  info: TagInfo
  phase: Phase | null
  onPlay: () => void
}): React.JSX.Element {
  return (
    <button
      className={`chip${phase === 'loading' ? ' ring-busy' : phase === 'playing' ? ' ring-on' : ''}`}
      aria-busy={phase !== null}
      onClick={onPlay}
      title={`Послушать: ${info.tag} ${info.sample}`}
    >
      {phase === 'loading' && <BusyRing />}
      <span className="mono">{info.tag}</span>
      <span className="chip-ru">{info.ru}</span>
      <Icon name="play" size={12} />
    </button>
  )
}

export function HelpPanel({ s }: { s: PublicSettings }): React.JSX.Element {
  const [playing, setPlaying] = useState<{ tag: string; phase: Phase } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const tagLimit = s.filters.antispam.tagLimit
  const prefix = s.filters.prefix.enabled ? (s.filters.prefix.list[0] ?? '') : ''
  const sheet = viewerCheatSheet(
    s.filters.prefix.list[0] ?? '',
    s.filters.prefix.enabled,
    tagLimit.mode === 'off' ? null : tagLimit.max
  )
  const phaseOf = (tag: string): Phase | null => (playing?.tag === tag ? playing.phase : null)

  const play = (info: TagInfo): void => {
    if (playing) return
    setPlaying({ tag: info.tag, phase: 'loading' })
    setError(null)
    const phrase = info.sample.includes(info.tag) ? info.sample : `${info.tag} ${info.sample}`
    void playTest(phrase, {
      onStart: () => setPlaying({ tag: info.tag, phase: 'playing' })
    }).then((err) => {
      setPlaying(null)
      setError(err)
    })
  }

  return (
    <div className="page help">
      <section className="group">
        <h3>Теги эмоций</h3>
        <p className="lead">
          Тег в квадратных скобках подсказывает голосу, как произнести фразу: с какой эмоцией, каким
          тоном, со смехом или вздохом. Сам тег вслух не читается.
        </p>
        <div className="example">
          <span className="mono">
            {prefix ? `${prefix} ` : ''}[excited] Мы прошли этот уровень. [laughing] Ха-ха.
          </span>
        </div>
        <ul className="rules">
          <li>Эмоцию ставьте в начало фразы. Тон и звуки можно в любое место.</li>
          <li>
            Можно описывать своими словами по-английски:{' '}
            <span className="mono">[warm and happy]</span>,{' '}
            <span className="mono">[slightly sad]</span>. Список ниже необязателен: это проверенные
            варианты.
          </li>
          <li>
            Не больше трёх тегов на фразу: так советует Fish, и так стоит по умолчанию в разделе
            "Фильтры".
          </li>
          <li>
            Круглые скобки <span className="mono">(laughing)</span> программа сама превращает в
            квадратные (раздел "Голос", настройка тегов).
          </li>
          <li>
            Fish поддерживает теги в русском тексте, но во всех примерах теги на английском. Русские
            теги вроде <span className="mono">[смеётся]</span> официально не обещаны: проверьте на
            своём голосе в разделе "Голос", блок "Проверить голос".
          </li>
        </ul>
        <p className="muted small">
          Нажмите на тег, чтобы послушать пример текущим голосом. Повторное нажатие играет
          сохранённую запись и не тратит деньги.
        </p>
        {error && <div className="banner err inline">{error}</div>}
      </section>

      <section className="group">
        <h3>Что где работает</h3>
        <p className="muted small">
          По документации Fish. Сейчас выбрана модель <span className="mono">{s.tts.model}</span>.
        </p>
        <div className="matrix" role="table">
          <div className="m-row m-head" role="row">
            <span role="columnheader" />
            {MODELS.map((m) => (
              <span
                key={m.id}
                role="columnheader"
                className={m.id === s.tts.model ? 'm-cur' : undefined}
              >
                <span className="mono">{m.id}</span>
                <span className="m-price">{m.price}</span>
              </span>
            ))}
          </div>
          {FEATURES.map((f) => (
            <div className="m-row" role="row" key={f.title}>
              <span role="rowheader">{f.title}</span>
              {f.on.map((ok, i) => (
                <span
                  key={MODELS[i]?.id}
                  role="cell"
                  className={`${ok ? 'm-yes' : 'm-no'}${MODELS[i]?.id === s.tts.model ? ' m-cur' : ''}`}
                >
                  {ok ? 'да' : 'нет'}
                </span>
              ))}
            </div>
          ))}
        </div>
        <p className="muted small mt">
          Список тегов ниже работает на всех моделях из таблицы, в том числе бесплатной. Разница
          между бесплатной и платными моделями s2 - в цене и лимитах, не в тегах.
        </p>
      </section>

      {TAG_GROUPS.map((g) => (
        <section className="group" key={g.title}>
          <h3>{g.title}</h3>
          <p className="muted small">{g.note}</p>
          <div className="chips">
            {g.tags.map((info) => (
              <TagChip
                key={info.tag}
                info={info}
                phase={phaseOf(info.tag)}
                onPlay={() => play(info)}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="group">
        <h3>Сочетания и сила</h3>
        <p className="muted small">
          Теги можно ставить подряд и усиливать словами slightly, very, extremely.
        </p>
        <div className="chips">
          {TAG_COMBOS.map((info) => (
            <TagChip
              key={info.tag}
              info={info}
              phase={phaseOf(info.tag)}
              onPlay={() => play(info)}
            />
          ))}
        </div>
      </section>

      <section className="group">
        <h3>Модель drama-3</h3>
        <p className="muted small">
          Для неё работают указания обычными словами в квадратных скобках, например{' '}
          <span className="mono">[barely holding it together]</span>, и парные теги, которые меняют
          подачу только внутри: <span className="mono">&lt;whisper&gt;тихо&lt;/whisper&gt;</span>.
          Парные теги от зрителей по умолчанию выключены (раздел "Голос").
        </p>
      </section>

      <section className="group">
        <h3>Шпаргалка для зрителей</h3>
        <p className="muted small">
          Короткий текст для чата, панели под стримом или команды бота. Префикс берётся из ваших
          настроек.
        </p>
        <div className="example">{sheet}</div>
        <div className="row mt">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(sheet).then(
                () => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                },
                () => setError('Не удалось скопировать. Выделите текст и нажмите Ctrl+C.')
              )
            }}
          >
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
          <span className="muted small">{sheet.length} из 500 символов сообщения Twitch</span>
        </div>
      </section>
    </div>
  )
}
