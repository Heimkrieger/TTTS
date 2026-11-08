// Простые элементы настроек. Всё применяется сразу, без кнопки "Сохранить".
import { useState } from 'react'

/**
 * Черновик поля ввода, который подхватывает новое значение из настроек,
 * если оно изменилось снаружи (без useEffect, как рекомендует React).
 */
function useDraft(source: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(source)
  const [prev, setPrev] = useState(source)
  if (source !== prev) {
    setPrev(source)
    setDraft(source)
  }
  return [draft, setDraft]
}

export function Toggle(props: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}): React.JSX.Element {
  return (
    <label className="ctl toggle switch">
      <input
        type="checkbox"
        checked={props.value}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="ctl-text">
        <span>{props.label}</span>
        {props.hint && <small className="hint">{props.hint}</small>}
      </span>
    </label>
  )
}

/** Переключатель из нескольких вариантов (кнопки в ряд). */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  hint?: string
}): React.JSX.Element {
  return (
    <div className="ctl">
      <span className="ctl-label">
        {props.label}
        {props.hint && <small className="hint">{props.hint}</small>}
      </span>
      <div className="seg">
        {props.options.map(([v, text]) => (
          <button
            key={v}
            className={v === props.value ? 'on' : ''}
            onClick={() => props.onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Число: сохраняется, когда поле теряет фокус или нажат Enter. */
export function NumberField(props: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  /** Знаков после запятой (0 - только целые). */
  decimals?: number
  onChange: (v: number) => void
}): React.JSX.Element {
  const [text, setText] = useDraft(String(props.value))
  const commit = (): void => {
    const k = 10 ** (props.decimals ?? 0)
    const n = Math.round(Number(text.replace(',', '.')) * k) / k
    if (Number.isFinite(n) && n >= props.min && n <= props.max) props.onChange(n)
    else setText(String(props.value))
  }
  return (
    <label className="ctl num">
      <span className="ctl-label">{props.label}</span>
      <input
        type="number"
        value={text}
        min={props.min}
        max={props.max}
        step={props.decimals ? 10 ** -props.decimals : 1}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {props.suffix && <span className="muted">{props.suffix}</span>}
    </label>
  )
}

/** Строка: сохраняется при потере фокуса или Enter. */
export function TextField(props: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const [text, setText] = useDraft(props.value)
  return (
    <label className="ctl">
      <span className="ctl-label">{props.label}</span>
      <input
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== props.value && props.onChange(text)}
        onKeyDown={(e) => e.key === 'Enter' && props.onChange(text)}
      />
    </label>
  )
}

/** Список: по одному значению на строку. Сохраняется при потере фокуса. */
export function ListField(props: {
  label: string
  value: string[]
  placeholder?: string
  hint?: string
  onChange: (v: string[]) => void
}): React.JSX.Element {
  const [text, setText] = useDraft(props.value.join('\n'))
  return (
    <label className="ctl">
      <span className="ctl-label">
        {props.label}
        {props.hint && <small className="hint">{props.hint}</small>}
      </span>
      <textarea
        rows={4}
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          props.onChange(
            text
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        }
      />
    </label>
  )
}

/** Группа галочек: можно отметить любые. note - пояснение под пунктом (почему недоступен). */
export function Checks<K extends string>(props: {
  label: string
  items: { key: K; label: string; checked: boolean; disabled?: boolean; note?: string }[]
  onChange: (key: K, checked: boolean) => void
  hint?: string
}): React.JSX.Element {
  return (
    <div className="ctl" role="group" aria-label={props.label}>
      <span className="ctl-label">{props.label}</span>
      <div className="checks">
        {props.items.map((it) => (
          <label key={it.key} className={`tick${it.disabled ? ' off' : ''}`} title={it.note}>
            <input
              type="checkbox"
              checked={it.checked}
              disabled={it.disabled}
              onChange={(e) => props.onChange(it.key, e.target.checked)}
            />
            <span>{it.label}</span>
            {it.note && <small className="hint">{it.note}</small>}
          </label>
        ))}
      </div>
      {props.hint && <small className="hint">{props.hint}</small>}
    </div>
  )
}
