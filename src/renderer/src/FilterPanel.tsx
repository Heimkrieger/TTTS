// Настройки фильтров и антиспама. Каждое правило - отдельный переключатель.
import { useState } from 'react'
import type { PublicSettings, RolesSettings, RuleMode, SettingsPatch } from '@shared/settings'
import { Checks, ListField, NumberField, Segmented, Toggle } from './controls'
import { IconButton } from './ui'

/**
 * Награды, которые озвучиваются. Названия задаёт стример: без входа в Twitch программа знает
 * только id награды из чата.
 */
function RewardList(props: {
  list: { id: string; title: string }[]
  onChange: (list: { id: string; title: string }[]) => void
}): React.JSX.Element {
  if (props.list.length === 0) {
    return (
      <div className="ctl">
        <span className="ctl-label">Награды для озвучки</span>
        <p className="muted small">
          Пока ни одной. Создайте на Twitch награду с вводом текста (в настройках баллов канала
          галка "Зритель должен ввести текст"), купите её сами за баллы один раз, затем в чате у
          этого сообщения нажмите кнопку с подарком "Озвучивать эту награду".
        </p>
      </div>
    )
  }
  return (
    <div className="ctl">
      <span className="ctl-label">Награды для озвучки</span>
      {props.list.map((r) => (
        <div key={r.id} className="row reward-row">
          <input
            defaultValue={r.title}
            maxLength={60}
            aria-label="Название награды"
            onBlur={(e) => {
              const title = e.target.value.trim() || r.title
              if (title !== r.title)
                props.onChange(props.list.map((x) => (x.id === r.id ? { ...x, title } : x)))
            }}
          />
          <span
            className="mono muted small"
            title="номер награды в Twitch, по нему программа её узнаёт"
          >
            {r.id.slice(0, 8)}
          </span>
          <IconButton
            icon="close"
            title="Больше не озвучивать эту награду"
            onClick={() => props.onChange(props.list.filter((x) => x.id !== r.id))}
          />
        </div>
      ))}
      <small className="hint">название видно только вам, Twitch его программе не сообщает</small>
    </div>
  )
}

const ROLE_ITEMS: [keyof RolesSettings, string][] = [
  ['everyone', 'Все зрители'],
  ['followers', 'Фолловеры'],
  ['subscribers', 'Подписчики'],
  ['vip', 'VIP'],
  ['moderators', 'Модераторы']
]

/** Список префиксов: подходит любой. Добавить - Enter, убрать - крестик. */
function PrefixList(props: {
  list: string[]
  onChange: (list: string[]) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const add = (): void => {
    const p = text.trim()
    if (!p || props.list.some((x) => x.toLowerCase() === p.toLowerCase())) {
      setText('')
      return
    }
    props.onChange([...props.list, p])
    setText('')
  }
  return (
    <div className="ctl prefixes">
      <span className="ctl-label">
        Префиксы
        <small className="hint">
          слово или знак в начале сообщения, по которому программа понимает, что его надо озвучить
        </small>
      </span>
      <div className="row wrap">
        {props.list.map((p) => (
          <span
            key={p}
            className="prefix-chip"
            title={
              props.list.length === 1
                ? 'Последний префикс нельзя убрать. Чтобы озвучивать весь чат, выключите "Только с префиксом"'
                : undefined
            }
          >
            <span className="mono">{p}</span>
            {props.list.length > 1 && (
              <IconButton
                icon="close"
                title={`Убрать ${p}`}
                onClick={() => props.onChange(props.list.filter((x) => x !== p))}
              />
            )}
          </span>
        ))}
        <input
          className="prefix-input"
          value={text}
          maxLength={20}
          aria-label="Новый префикс"
          placeholder="добавить, например !tts"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          onBlur={add}
        />
      </div>
    </div>
  )
}

type Patch = (p: SettingsPatch) => void

const RULE: [RuleMode, string][] = [
  ['off', 'не трогать'],
  ['compress', 'сокращать'],
  ['reject', 'не озвучивать']
]

export function FilterPanel({ s, set }: { s: PublicSettings; set: Patch }): React.JSX.Element {
  const f = s.filters
  const a = f.antispam
  const [rolesError, setRolesError] = useState<string | null>(null)
  const anti = (p: NonNullable<NonNullable<SettingsPatch['filters']>['antispam']>): void =>
    set({ filters: { antispam: p } })

  return (
    <div className="panel-scroll">
      <section className="group">
        <h3>Кто и что озвучивается</h3>
        <Toggle
          label="Озвучка включена"
          value={s.tts.enabled}
          onChange={(v) => set({ tts: { enabled: v } })}
        />
        <Segmented
          label="Что запускает озвучку"
          value={f.trigger}
          options={[
            ['prefix', 'префикс'],
            ['reward', 'награда за баллы'],
            ['both', 'префикс и награда']
          ]}
          onChange={(v) => set({ filters: { trigger: v } })}
          hint="сообщения за награду и по префиксу проходят одни и те же проверки и встают в общую очередь"
        />
        {f.trigger !== 'reward' && (
          <>
            <Toggle
              label="Только с префиксом"
              hint="если выключить, озвучивается весь чат"
              value={f.prefix.enabled}
              onChange={(v) => set({ filters: { prefix: { enabled: v } } })}
            />
            {f.prefix.enabled && (
              <PrefixList
                list={f.prefix.list}
                onChange={(list) => set({ filters: { prefix: { list } } })}
              />
            )}
          </>
        )}
        {f.trigger !== 'prefix' && (
          <RewardList list={f.rewards} onChange={(rewards) => set({ filters: { rewards } })} />
        )}
        <Checks<keyof RolesSettings>
          label="Кто может озвучивать"
          items={ROLE_ITEMS.map(([key, label]) => ({
            key,
            label,
            checked: f.roles[key],
            // Фоловеров видно только со входом в Twitch.
            disabled: key === 'followers',
            note: key === 'followers' ? 'программа пока не видит фолловеров' : undefined
          }))}
          onChange={(key, on) => {
            if (!on && Object.values({ ...f.roles, [key]: false }).every((v) => !v)) {
              setRolesError('Нужна хотя бы одна галка. Сначала отметьте другую, потом снимите эту.')
              return
            }
            setRolesError(null)
            // Отметили конкретную роль - уже не "все зрители"; отметили "все" - роли не нужны.
            const patch: Partial<RolesSettings> =
              key === 'everyone' && on
                ? { everyone: true, subscribers: false, vip: false, moderators: false }
                : on
                  ? { [key]: true, everyone: false }
                  : { [key]: false }
            set({ filters: { roles: patch } })
          }}
          hint="достаточно одной отмеченной галки, вы сами можете всегда. Фолловеров программа пока не видит: для этого нужен вход через Twitch, он появится позже"
        />
        {rolesError && <p className="err small">{rolesError}</p>}
        <NumberField
          label="Кулдаун зрителя"
          value={f.userCooldownSec}
          min={0}
          max={3600}
          suffix="с: перерыв между сообщениями одного зрителя (0 - без кулдауна)"
          onChange={(v) => set({ filters: { userCooldownSec: v } })}
        />
      </section>

      <section className="group">
        <h3>Чистка текста</h3>
        <Segmented
          label="Ссылки"
          value={f.links}
          options={[
            ['off', 'оставлять'],
            ['strip', 'вырезать'],
            ['reject', 'не озвучивать сообщение']
          ]}
          onChange={(v) => set({ filters: { links: v } })}
        />
        <Toggle
          label="Вырезать эмоуты Twitch"
          value={f.emotes.twitch}
          onChange={(v) => set({ filters: { emotes: { twitch: v } } })}
        />
        <Toggle
          label="Вырезать эмоуты 7TV, BTTV, FFZ"
          value={f.emotes.thirdParty}
          onChange={(v) => set({ filters: { emotes: { thirdParty: v } } })}
        />
        <Toggle
          label="Вырезать эмодзи"
          value={f.emotes.emoji}
          onChange={(v) => set({ filters: { emotes: { emoji: v } } })}
        />
      </section>

      <section className="group">
        <h3>Антиспам</h3>
        <p className="muted small">
          "Сокращать": повторы урезаются, сообщение звучит короче. "Не озвучивать": сообщение с
          таким повтором пропускается.
        </p>
        <Segmented
          label="Одна буква много раз подряд"
          hint="аааааа"
          value={a.letterRepeat}
          options={RULE}
          onChange={(v) => anti({ letterRepeat: v })}
        />
        <Segmented
          label="Повтор слога"
          hint="брбрбрбр"
          value={a.syllableRepeat}
          options={RULE}
          onChange={(v) => anti({ syllableRepeat: v })}
        />
        <Segmented
          label="Повтор слов и фраз"
          hint="ы ы ы ы, лол лол лол"
          value={a.wordRepeat}
          options={RULE}
          onChange={(v) => anti({ wordRepeat: v })}
        />
        <Segmented
          label="Смех и звуки"
          hint="ухухуахахахехех"
          value={a.laughter}
          options={RULE}
          onChange={(v) => anti({ laughter: v })}
        />
        <Toggle
          label="Различать большие и маленькие буквы"
          hint="БрБр и брбр считаются разными"
          value={a.caseSensitive}
          onChange={(v) => anti({ caseSensitive: v })}
        />
        <div className="row">
          <Segmented
            label="Если повторы заняли больше"
            value={a.threshold.mode}
            options={[
              ['compress', 'озвучить сокращённое'],
              ['reject', 'не озвучивать']
            ]}
            onChange={(v) => anti({ threshold: { mode: v } })}
          />
          <NumberField
            label=""
            value={a.threshold.percent}
            min={1}
            max={100}
            suffix="% текста"
            onChange={(v) => anti({ threshold: { percent: v } })}
          />
        </div>
      </section>

      <section className="group">
        <h3>Теги эмоций от зрителей</h3>
        <Toggle
          label="Склеивать одинаковые теги подряд"
          hint="[moan] [moan] станет [moan]"
          value={a.dupTags}
          onChange={(v) => anti({ dupTags: v })}
        />
        <div className="row">
          <Segmented
            label="Лимит тегов в сообщении"
            value={a.tagLimit.mode}
            options={[
              ['off', 'без лимита'],
              ['compress', 'оставить первые'],
              ['reject', 'не озвучивать']
            ]}
            onChange={(v) => anti({ tagLimit: { mode: v } })}
          />
          <NumberField
            label=""
            value={a.tagLimit.max}
            min={0}
            max={50}
            suffix="тегов"
            onChange={(v) => anti({ tagLimit: { max: v } })}
          />
        </div>
        <Segmented
          label="Действия в звёздочках"
          hint="*moans*"
          value={a.actions}
          options={[
            ['asis', 'как есть'],
            ['tag', 'в тег [moans]'],
            ['strip', 'вырезать']
          ]}
          onChange={(v) => anti({ actions: v })}
        />
        <Segmented
          label="Сообщение только из тегов"
          value={a.tagsOnly}
          options={[
            ['allow', 'озвучивать'],
            ['reject', 'не озвучивать']
          ]}
          onChange={(v) => anti({ tagsOnly: v })}
        />
      </section>

      <section className="group">
        <h3>Ограничения</h3>
        <ListField
          label="Стоп-слова"
          hint="по одному слову или фразе на строку, большие и маленькие буквы не различаются"
          value={f.stopWords.list}
          onChange={(v) => set({ filters: { stopWords: { list: v } } })}
        />
        <Segmented
          label="Стоп-слово в сообщении"
          value={f.stopWords.mode}
          options={[
            ['reject', 'не озвучивать сообщение'],
            ['beep', 'заменить на "пип"']
          ]}
          onChange={(v) => set({ filters: { stopWords: { mode: v } } })}
        />
        <div className="row">
          <NumberField
            label="Длина от"
            value={f.length.min}
            min={0}
            max={1000}
            onChange={(v) => set({ filters: { length: { min: v } } })}
          />
          <NumberField
            label="до"
            value={f.length.max}
            min={1}
            max={5000}
            suffix="символов"
            onChange={(v) => set({ filters: { length: { max: v } } })}
          />
        </div>
        <NumberField
          label="Один и тот же текст не чаще чем раз в"
          value={f.duplicateSec}
          min={0}
          max={3600}
          suffix="с (0 - не проверять)"
          onChange={(v) => set({ filters: { duplicateSec: v } })}
        />
        <NumberField
          label="Максимум в очереди"
          value={f.maxQueue}
          min={1}
          max={500}
          suffix="сообщений: новые сверх этого не озвучиваются"
          onChange={(v) => set({ filters: { maxQueue: v } })}
        />
      </section>
    </div>
  )
}
