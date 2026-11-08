// Значки у ника (стример, модератор, VIP, подписчик с месяцами, Prime) и строка "в ответ @ник".
// Данные приходят из чата Twitch без входа; картинки свои, в стиле программы.
import { nickColor } from '@shared/nickColor'
import type { Badge, ChatMessage } from '@shared/types'

const ORDER: Badge[] = ['broadcaster', 'moderator', 'vip', 'subscriber', 'prime']

const TITLE: Record<Badge, string> = {
  broadcaster: 'Стример',
  moderator: 'Модератор',
  vip: 'VIP',
  subscriber: 'Подписчик',
  prime: 'Prime Gaming'
}

/** Значок 12x12: камера, меч, бриллиант, звезда, корона. */
function Glyph({ badge }: { badge: Badge }): React.JSX.Element {
  switch (badge) {
    case 'broadcaster':
      return (
        <path d="M1 4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1zM8.5 6 11 4v4z" />
      )
    case 'moderator':
      return (
        <path
          d="M4 8 10 2M2.5 6.5l3 3M2 10l1.6-1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )
    case 'vip':
      return <path d="M3 2h6l2 3-5 5.5L1 5z" />
    case 'subscriber':
      return <path d="M6 1l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6 8.8 3 10.4l.6-3.4L1.1 4.6l3.4-.5z" />
    case 'prime':
      return <path d="M1.5 9.5h9L11 3.5 8.2 5.5 6 2 3.8 5.5 1 3.5z" />
  }
}

export function ChatBadges({ m }: { m: ChatMessage }): React.JSX.Element | null {
  const list = ORDER.filter((b) => m.badges.includes(b))
  if (list.length === 0) return null
  return (
    <span className="badges">
      {list.map((b) => {
        const months = b === 'subscriber' ? m.subMonths : null
        const title = months ? `${TITLE[b]}, ${months} мес.` : TITLE[b]
        return (
          <span key={b} className={`badge badge-${b}`} title={title} aria-label={title}>
            <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" aria-hidden="true">
              <Glyph badge={b} />
            </svg>
            {months !== null && <span className="badge-num">{months}</span>}
          </span>
        )
      })}
    </span>
  )
}

/** Ник в цвете Twitch (высветленный до читаемого на тёмном фоне). */
export function Nick({ m }: { m: ChatMessage }): React.JSX.Element {
  return (
    <span className="nick" style={{ color: nickColor(m.color, m.user) }}>
      {m.displayName}
    </span>
  )
}

/** "в ответ @ник: текст" над сообщением-ответом. */
export function ReplyLine({ m }: { m: ChatMessage }): React.JSX.Element | null {
  if (!m.reply) return null
  return (
    <div className="reply" title={`${m.reply.displayName}: ${m.reply.text}`}>
      в ответ <span className="reply-nick">@{m.reply.displayName}</span>
      {m.reply.text && <span className="reply-text">: {m.reply.text}</span>}
    </div>
  )
}
