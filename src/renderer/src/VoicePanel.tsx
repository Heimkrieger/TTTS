// Голос Fish: модель, избранные голоса, поиск, добавление по ссылке, тест, выразительность, теги.
import { useState } from 'react'
import {
  FISH_MODELS,
  FISH_PRICE_PER_MB,
  FISH_VOICES_URL,
  DEFAULT_VOICE,
  RECOMMENDED_VOICES,
  type PublicSettings,
  type SettingsPatch
} from '@shared/settings'
import type { FishStatus, VoiceInfo } from '@shared/types'
import { ListField, NumberField, Segmented, Toggle } from './controls'
import { playTest } from './playTest'
import { IconButton } from './ui'

const fmtUses = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс` : String(n)

export function VoicePanel(props: {
  s: PublicSettings
  fish: FishStatus
  set: (p: SettingsPatch) => void
  onHelp: () => void
}): React.JSX.Element {
  const { s, fish, set } = props
  const t = s.tts
  const [query, setQuery] = useState('')
  const [lang, setLang] = useState<'ru' | ''>('ru')
  const [found, setFound] = useState<VoiceInfo[] | null>(null)
  const [link, setLink] = useState('')
  const [phrase, setPhrase] = useState('[laughing] Привет, чат. Это проверка голоса.')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Какой готовый голос сейчас готовится или звучит (кнопка "Послушать"). */
  const [listening, setListening] = useState<string | null>(null)
  const listen = (id: string): void => {
    setListening(id)
    setError(null)
    void playTest('Привет, чат. Так звучит этот голос.', { voiceId: id }).then((err) => {
      setListening(null)
      if (err) setError(err)
    })
  }
  const noKey = fish.key === 'none' || fish.key === 'unreadable'

  const search = (): void => {
    setBusy('search')
    setError(null)
    void window.api.fish.searchVoices(query, lang || null).then((r) => {
      setBusy(null)
      if (r.ok) setFound(r.value)
      else setError(r.error)
    })
  }
  const test = (): void => {
    setBusy('test')
    setError(null)
    void playTest(phrase).then((err) => {
      setBusy(null)
      setError(err)
    })
  }

  return (
    <div className="page">
      {noKey && (
        <div className="banner warn inline">
          {fish.key === 'unreadable'
            ? 'Сохранённый ключ не читается на этом компьютере. Введите его заново в разделе "Подключение". Пока ключа нет, очередь идёт без звука.'
            : 'Нет ключа Fish Audio: добавьте его в разделе "Подключение". Без ключа очередь идёт без звука.'}
        </div>
      )}
      <section className="group">
        <h3>Модель</h3>
        <p className="muted small">
          Модель - это версия голосового движка Fish. От неё зависят качество и цена.
        </p>
        <Segmented
          label=""
          value={t.model}
          options={FISH_MODELS.map((m) => [
            m,
            `${m}${FISH_PRICE_PER_MB[m] === 0 ? ' (бесплатно)' : ` ($${FISH_PRICE_PER_MB[m]} за 1 млн байт)`}`
          ])}
          onChange={(v) => set({ tts: { model: v } })}
          hint=""
        />
        <p className="muted small">
          Деньги Fish считает по байтам текста: русская буква - 2 байта, английская - 1. Обычное
          сообщение чата на платной модели стоит около $0.002.
        </p>
        {FISH_PRICE_PER_MB[t.model] > 0 && (
          <div className="budget">
            <NumberField
              label="Лимит трат в день"
              value={t.budget.dailyUsd}
              min={0}
              max={1000}
              decimals={2}
              suffix="$ (0 - без лимита)"
              onChange={(v) => set({ tts: { budget: { dailyUsd: v } } })}
            />
            <Segmented
              label="Когда лимит кончился"
              value={t.budget.onLimit}
              options={[
                ['free', 'читать бесплатной моделью'],
                ['pause', 'поставить озвучку на паузу']
              ]}
              onChange={(v) => set({ tts: { budget: { onLimit: v } } })}
              hint="второй ключ не нужен: бесплатная модель работает тем же ключом Fish. Новый день начинается в полночь по часам компьютера"
            />
            {fish.budget.active && (
              <p className={`small ${fish.budget.exceeded ? 'warn' : 'muted'}`}>
                Сегодня потрачено ${fish.budget.spentUsd.toFixed(2)} из $
                {fish.budget.limitUsd.toFixed(2)}
                {fish.budget.exceeded
                  ? fish.budget.onLimit === 'free'
                    ? '. Лимит кончился, до полуночи читает бесплатная модель.'
                    : '. Лимит кончился, озвучка на паузе. Поднимите лимит или выберите "читать бесплатной моделью".'
                  : '.'}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="group">
        <h3>Готовые голоса</h3>
        <p className="muted small">
          Голоса с fish.audio. Послушайте и добавьте понравившиеся в избранное. Другие голоса можно
          найти поиском ниже или в{' '}
          <a href={FISH_VOICES_URL} target="_blank" rel="noreferrer">
            каталоге на сайте fish.audio
          </a>
          : откройте голос, скопируйте адрес страницы и вставьте его в поле под избранным.
        </p>
        {[DEFAULT_VOICE, ...RECOMMENDED_VOICES].map((v) => {
          const saved = t.voices.some((x) => x.id === v.id)
          return (
            <div key={v.id} className="row listrow voice">
              <span className="voice-name">{v.title}</span>
              <button
                disabled={noKey || listening !== null}
                onClick={() => listen(v.id)}
                title={noKey ? 'Нужен ключ Fish Audio (раздел "Подключение")' : undefined}
              >
                {listening === v.id ? 'Готовлю...' : 'Послушать'}
              </button>
              <button
                disabled={saved}
                onClick={() => void window.api.fish.saveVoice(v.id, v.title)}
              >
                {saved ? 'В избранном' : 'В избранное'}
              </button>
            </div>
          )
        })}
      </section>

      <section className="group">
        <h3>Избранные голоса</h3>
        {t.voices.length === 0 && (
          <p className="muted">Пока пусто. Найдите голос ниже или вставьте ссылку на него.</p>
        )}
        {t.voices.map((v) => (
          <div key={v.id} className={`row listrow voice${t.voiceId === v.id ? ' on' : ''}`}>
            <label className="switch">
              <input
                type="radio"
                name="voice"
                checked={t.voiceId === v.id}
                onChange={() => set({ tts: { voiceId: v.id } })}
              />
              <span>{v.title}</span>
            </label>
            <span className="muted mono small">{v.id.slice(0, 8)}</span>
            <IconButton
              icon="close"
              title="Убрать из избранного"
              onClick={() => void window.api.fish.removeVoice(v.id)}
            />
          </div>
        ))}
        <div className="row wrap mt">
          <input
            value={link}
            aria-label="Ссылка на голос"
            placeholder="ссылка на страницу голоса на fish.audio"
            onChange={(e) => setLink(e.target.value)}
          />
          <button
            disabled={!link.trim() || noKey || busy !== null}
            onClick={() => {
              setBusy('add')
              void window.api.fish.addVoice(link).then((r) => {
                setBusy(null)
                if (r.ok) setLink('')
                setError(r.ok ? null : r.error)
              })
            }}
          >
            Добавить
          </button>
        </div>
      </section>

      <section className="group">
        <h3>Проверить голос</h3>
        <div className="row wrap">
          <input
            value={phrase}
            aria-label="Фраза для проверки голоса"
            placeholder="фраза для проверки"
            onChange={(e) => setPhrase(e.target.value)}
          />
          <button disabled={noKey || busy !== null} onClick={test}>
            {busy === 'test' ? 'Готовлю...' : 'Проверить'}
          </button>
        </div>
        <p className="muted small">
          Фраза звучит сразу, без очереди, текущим голосом и моделью. На платной модели проверка
          стоит денег.{' '}
          <button className="link" onClick={props.onHelp}>
            Какие бывают теги
          </button>
        </p>
      </section>

      <section className="group">
        <h3>Поиск голосов</h3>
        <div className="row wrap">
          <input
            value={query}
            aria-label="Поиск голосов"
            placeholder="название, например: аниме, диктор, кот"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <Segmented
            label=""
            value={lang === '' ? 'all' : 'ru'}
            options={[
              ['ru', 'русские'],
              ['all', 'все']
            ]}
            onChange={(v) => setLang(v === 'ru' ? 'ru' : '')}
          />
          <button disabled={noKey || busy !== null} onClick={search}>
            {busy === 'search' ? 'Ищу...' : 'Найти'}
          </button>
        </div>
        {found && found.length === 0 && (
          <p className="muted">Ничего не нашлось. Попробуйте другое слово или включите "все".</p>
        )}
        {found?.map((v) => (
          <div key={v.id} className="row listrow">
            <b>{v.title}</b>
            <span className="muted small">
              {v.languages.join(', ')} · использований: {fmtUses(v.uses)}
              {v.author ? ` · ${v.author}` : ''}
            </span>
            <button
              className="push"
              onClick={() => void window.api.fish.saveVoice(v.id, v.title)}
              disabled={t.voices.some((x) => x.id === v.id)}
            >
              {t.voices.some((x) => x.id === v.id) ? 'В избранном' : 'В избранное'}
            </button>
          </div>
        ))}
      </section>

      <section className="group">
        <h3>Подача</h3>
        <NumberField
          label="Выразительность"
          value={Math.round(t.temperature * 100)}
          min={0}
          max={100}
          suffix="% (больше - живее, меньше - ровнее)"
          onChange={(v) => set({ tts: { temperature: v / 100 } })}
        />
        <NumberField
          label="Разнообразие"
          value={Math.round(t.topP * 100)}
          min={0}
          max={100}
          suffix="% (если голос иногда несёт чушь, уменьшите)"
          onChange={(v) => set({ tts: { topP: v / 100 } })}
        />
      </section>

      <section className="group">
        <h3>
          Как Fish читает теги{' '}
          <button className="link" onClick={props.onHelp}>
            справка по тегам
          </button>
        </h3>
        <Segmented
          label="Теги в сообщениях"
          value={t.tags.mode}
          options={[
            ['convert', '(вздох) в [вздох]'],
            ['asis', 'как есть'],
            ['strip', 'вырезать все']
          ]}
          onChange={(v) => set({ tts: { tags: { mode: v } } })}
          hint="Fish понимает только квадратные скобки, круглые программа может переделать сама"
        />
        <Toggle
          label="Разрешить парные теги"
          hint="<whisper>текст</whisper>, для модели drama-3"
          value={t.tags.allowPaired}
          onChange={(v) => set({ tts: { tags: { allowPaired: v } } })}
        />
        <ListField
          label="Запрещённые слова в тегах"
          hint="тег с таким словом вырезается; по одному на строку"
          value={t.tags.blockedWords}
          onChange={(v) => set({ tts: { tags: { blockedWords: v } } })}
        />
      </section>

      {error && <div className="banner err inline">{error}</div>}
    </div>
  )
}
