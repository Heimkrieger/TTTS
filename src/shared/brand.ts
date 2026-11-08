// Название программы.
export const APP_NAME = 'TwitchTTS'

/**
 * Куда ведёт кнопка "Поддержать автора" внизу меню (DonationAlerts или Boosty автора).
 * Программа бесплатная. Пусто - кнопка не показывается.
 */
export const SUPPORT_URL = ''

/**
 * Адрес посредника для отзывов (feedback-relay/, Cloudflare Worker автора), например
 * https://feedback.<имя>.workers.dev/report. Пусто - форма работает, но вместо отправки
 * предлагает скопировать текст.
 */
export const FEEDBACK_URL = ''

/**
 * Откуда брать обновления: репозиторий GitHub "владелец/имя" (релизы с архивом и подписью).
 * Пусто - обновления выключены.
 */
export const UPDATE_REPO = 'Heimkrieger/TTTS'

/**
 * Открытый ключ подписи обновлений (Ed25519, PEM). Закрытый ключ - только у автора и в секрете
 * GitHub Actions; без верной подписи архив не устанавливается. Пусто - обновления выключены.
 */
export const UPDATE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAl4lF3pft5vsE8MRTpLNrLHuwWmo+UzLpdrjUspePnwk=',
  '-----END PUBLIC KEY-----'
].join('\n')

/**
 * Куда писать автору, если отчёт не ушёл из программы (Telegram или почта), например
 * "@имя в Telegram". Пусто - тексты просят прислать отчёт, когда автор укажет контакт.
 */
export const AUTHOR_CONTACT = ''

/** Хвост фразы "пришлите автору...": с контактом или без него. */
export const sendToAuthor = (): string =>
  AUTHOR_CONTACT ? `пришлите автору: ${AUTHOR_CONTACT}` : 'пришлите автору, когда он укажет контакт'
