// Схема настроек. Значения по умолчанию задаются здесь и только здесь.
import { z } from 'zod'
import { isRiskyRegex } from './regexSafety'

/**
 * Версия формата файла настроек. 2: префикс стал списком (prefix.list вместо prefix.value).
 * 3: "кто может озвучивать" - галочки вместо одного уровня; мастер первого запуска (ui).
 */
export const SETTINGS_VERSION = 4

/** Модели Fish. s1 не поддерживаем (отключается 31.12.2026). */
export const FISH_MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3'] as const
export type FishModel = (typeof FISH_MODELS)[number]

/**
 * Голос по умолчанию: "Rin Tohsaka" с fish.audio, самый популярный
 * публичный голос с этим именем (японский, говорит и по-русски). Русского "Тосака Рин" в поиске нет.
 */
export const DEFAULT_VOICE = {
  id: '0efe389bb7b544c690da2fbeee0831d8',
  title: 'Rin Tohsaka'
} as const

/**
 * Готовые голоса: популярные русские голоса Fish, без копий реальных людей
 * (блогеров, политиков, актёров). Подобраны по числу использований на fish.audio.
 * Название и пометка - наши, короткие, чтобы было понятно, что выбирать.
 */
export const RECOMMENDED_VOICES = [
  {
    id: '2a1036d645634680b3cc69aeeb60375b',
    title: 'Спокойный женский',
    note: 'ровный, подходит любому чату'
  },
  { id: 'd567e990d9ad433892ed15ecfd70ce54', title: 'Молодой женский', note: 'чёткая дикция' },
  { id: 'c2805221e4b544458014d610f82b5aa5', title: 'Дикторский женский', note: 'как в новостях' },
  { id: '7312c38557eb4fb384e3874e8e9cea67', title: 'Уверенный мужской', note: 'чёткая подача' },
  {
    id: '48ec28a45588422b977a86460c11977f',
    title: 'Энергичный мужской',
    note: 'бодрый рассказчик'
  },
  {
    id: '6ada82e315e648b6a30a2e2210844cbf',
    title: 'Дерзкий парень',
    note: 'разговорный, с характером'
  }
] as const

/** Каталог голосов на сайте Fish: найти голос, скопировать ссылку, вставить в "Голос". */
export const FISH_VOICES_URL = 'https://fish.audio/discovery/'

/** Цена за 1 млн байт UTF-8 текста, $ (страница Pricing у Fish). */
export const FISH_PRICE_PER_MB: Record<FishModel, number> = {
  's2.1-pro-free': 0,
  's2.1-pro': 15,
  's2-pro': 15,
  'drama-3': 50
}

/** Имя канала Twitch: пусто или 3-25 символов [a-z0-9_]. */
const channelSchema = z
  .string()
  .regex(
    /^$|^[a-z0-9_]{3,25}$/,
    'Имя канала: от 3 до 25 латинских букв, цифр или "_". Проверьте, нет ли пробелов и русских букв.'
  )

/** Режим правила антиспама: выключено / сжимать / отклонять сообщение. */
export const ruleModeSchema = z.enum(['off', 'compress', 'reject'])
export type RuleMode = z.infer<typeof ruleModeSchema>

/** Стоп-слово: обычное слово или регулярное выражение вида /шаблон/флаги. */
const stopWordSchema = z
  .string()
  .min(1)
  .max(200)
  .superRefine((w, ctx) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(w)
    if (!m) return
    try {
      new RegExp(m[1] ?? '', m[2])
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `Стоп-слово ${w} записано с ошибкой. Если это обычное слово, уберите косые черты по краям.`
      })
      return
    }
    if (isRiskyRegex(m[1] ?? '')) {
      ctx.addIssue({
        code: 'custom',
        message: `Стоп-слово ${w} может подвесить программу на длинных сообщениях (повтор внутри повтора, например (а+)+). Упростите его.`
      })
    }
  })

export const filtersSchema = z.object({
  /** Игнорируемые ники (в нижнем регистре). */
  blacklist: z
    .array(z.string().max(50))
    .max(2000)
    .default(['nightbot', 'streamelements', 'moobot']),
  prefix: z
    .object({
      enabled: z.boolean().default(true),
      /** Префиксы, с которых начинается сообщение для озвучки. Подходит любой из списка. */
      list: z
        .array(z.string().trim().min(1, 'Префикс не может быть пустым').max(20))
        .min(1, 'Нужен хотя бы один префикс или выключите "Только с префиксом"')
        .default(['!!!'])
    })
    .prefault({}),
  /** Что запускает озвучку: префикс в сообщении, награда за баллы канала или то и другое. */
  trigger: z.enum(['prefix', 'reward', 'both']).default('prefix'),
  /**
   * Награды за баллы, которые озвучиваются. id приходит из чата Twitch (тег custom-reward-id),
   * название задаёт стример: без входа в Twitch программа его не знает.
   */
  rewards: z
    .array(z.object({ id: z.string().min(1).max(64), title: z.string().max(60) }))
    .max(20)
    .default([]),
  /**
   * Кто может озвучивать: подходит под любую отмеченную галку. Стример может всегда.
   * everyone отмечен - проходят все. followers проверяется только со входом в Twitch.
   */
  roles: z
    .object({
      everyone: z.boolean().default(true),
      followers: z.boolean().default(false),
      subscribers: z.boolean().default(false),
      vip: z.boolean().default(false),
      moderators: z.boolean().default(false)
    })
    .refine(
      (r) => Object.values(r).some(Boolean),
      'Отметьте хотя бы одну галку "Кто может озвучивать"'
    )
    .prefault({}),
  /** Не чаще раза в N секунд от одного зрителя. 0 - без ограничения. */
  userCooldownSec: z.number().int().min(0).max(3600).default(30),
  links: z.enum(['off', 'strip', 'reject']).default('strip'),
  emotes: z
    .object({
      twitch: z.boolean().default(true),
      thirdParty: z.boolean().default(true),
      emoji: z.boolean().default(true)
    })
    .prefault({}),
  antispam: z
    .object({
      /** аааааа: больше 4 одинаковых букв подряд -> 3. */
      letterRepeat: ruleModeSchema.default('compress'),
      /** брбрбрбр: блок 2-5 символов больше 3 раз подряд -> 3 повтора. */
      syllableRepeat: ruleModeSchema.default('compress'),
      /** УМА УМА САМБА САМБА САМБА x4: фраза 1-6 слов 4+ раз подряд -> 2 повтора. */
      wordRepeat: ruleModeSchema.default('compress'),
      /** ухухуахахахехех: длинная цепочка слогов смеха -> коротко. */
      laughter: ruleModeSchema.default('compress'),
      /** [moan] [moan] -> [moan]. */
      dupTags: z.boolean().default(true),
      tagLimit: z
        .object({
          mode: ruleModeSchema.default('compress'),
          max: z.number().int().min(0).max(50).default(3)
        })
        .prefault({}),
      /** *moans*: как есть / превратить в тег [moans] / вырезать. */
      actions: z.enum(['asis', 'tag', 'strip']).default('asis'),
      /** Сообщение только из тегов, без слов. */
      tagsOnly: z.enum(['allow', 'reject']).default('allow'),
      /** Если сжатие убрало больше percent% текста: compress - оставить сжатое, reject - отклонить. */
      threshold: z
        .object({
          mode: z.enum(['compress', 'reject']).default('compress'),
          percent: z.number().int().min(1).max(100).default(40)
        })
        .prefault({}),
      /** Учитывать регистр при поиске повторов (БрБр и брбр - разное). */
      caseSensitive: z.boolean().default(false)
    })
    .prefault({}),
  stopWords: z
    .object({
      list: z.array(stopWordSchema).max(500).default([]),
      mode: z.enum(['reject', 'beep']).default('reject')
    })
    .prefault({}),
  length: z
    .object({
      min: z.number().int().min(0).max(1000).default(2),
      max: z.number().int().min(1).max(5000).default(300)
    })
    .prefault({}),
  /** Тот же текст от любого зрителя за N секунд - отказ. 0 - выключено. */
  duplicateSec: z.number().int().min(0).max(3600).default(60),
  /** Если в очереди уже столько сообщений - отказ. */
  maxQueue: z.number().int().min(1).max(500).default(100)
})

export type FilterSettings = z.infer<typeof filtersSchema>

export const settingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  twitch: z
    .object({
      channel: channelSchema.default('')
    })
    .prefault({}),
  tts: z
    .object({
      enabled: z.boolean().default(true),
      /** Модель Fish: только из списка FISH_MODELS (опечатка в имени = тихая подмена на s2.1-pro). */
      model: z.enum(FISH_MODELS).default('s2.1-pro-free'),
      /** Текущий голос (id модели голоса на fish.audio). Пусто - голос по умолчанию Fish. */
      voiceId: z.string().max(64).default(DEFAULT_VOICE.id),
      /** Избранные голоса с именами. */
      voices: z
        .array(z.object({ id: z.string(), title: z.string() }))
        .default([
          { ...DEFAULT_VOICE },
          ...RECOMMENDED_VOICES.map(({ id, title }) => ({ id, title }))
        ]),
      /** Выразительность (Fish temperature) и разнообразие (top_p), 0-1. */
      temperature: z.number().min(0).max(1).default(0.7),
      topP: z.number().min(0).max(1).default(0.7),
      tags: z
        .object({
          /** asis - как есть; convert - (x) превращать в [x]; strip - вырезать все теги. */
          mode: z.enum(['asis', 'convert', 'strip']).default('convert'),
          /** Парные теги вида <whisper>...</whisper> (drama-3). Выкл - разметка вырезается, текст остаётся. */
          allowPaired: z.boolean().default(false),
          /** Слова, которые нельзя использовать внутри тегов: такой тег вырезается. */
          blockedWords: z.array(z.string().max(100)).max(500).default([])
        })
        .prefault({}),
      /** Читать ник перед сообщением по шаблону. Ник чистится от цифр, "_" и повторов букв. */
      readNick: z
        .object({
          enabled: z.boolean().default(false),
          template: z
            .string()
            .max(100)
            .refine(
              (t) => t.includes('{текст}'),
              'В шаблоне должно быть {текст}, иначе само сообщение не прозвучит'
            )
            .default('{ник} пишет: {текст}')
        })
        .prefault({}),
      /**
       * Дневной бюджет на платные модели: лимит в $ (0 - без лимита) и что делать, когда он
       * исчерпан: читать бесплатной моделью тем же ключом или поставить озвучку на паузу.
       */
      budget: z
        .object({
          dailyUsd: z.number().min(0).max(1000).default(1),
          onLimit: z.enum(['free', 'pause']).default('free')
        })
        .prefault({}),
      /** Скорость речи (prosody.speed у Fish): 0.5 - 2.0. */
      speed: z.number().min(0.5).max(2).default(1),
      /** Громкость, %: 0 - 200. */
      volume: z.number().int().min(0).max(200).default(100),
      /** Пауза между сообщениями, мс. */
      pauseBetweenMs: z.number().int().min(0).max(10000).default(300),
      /** Лимит длительности одного сообщения, секунды. */
      maxDurationSec: z.number().int().min(3).max(600).default(45),
      /** Что делать, если длиннее лимита: пропустить или обрезать (с плавным затуханием). */
      overLimit: z.enum(['skip', 'trim']).default('skip')
    })
    .prefault({}),
  filters: filtersSchema.prefault({}),
  /** Вывод звука. */
  audio: z
    .object({
      /**
       * Куда идёт звук: device - устройство Windows (динамики, наушники); cable - виртуальный кабель
       * (тоже устройство, но список фильтруется); obs - в источник "Браузер" в OBS через локальную страницу.
       */
      output: z.enum(['device', 'cable', 'obs']).default('device'),
      /** Порт локальной страницы для OBS (оверлей и звук). */
      obsPort: z.number().int().min(1024).max(65535).default(5190),
      /** Показывать в оверлее ник и текст того, что звучит. */
      overlayText: z.boolean().default(true),
      /** Устройство вывода: id и имя (id у Chromium может меняться, тогда ищем по имени). Пусто - по умолчанию Windows. */
      deviceId: z.string().max(200).default(''),
      deviceLabel: z.string().max(200).default(''),
      /** Второй выход "монитор": стример слышит TTS в наушниках, пока основной идёт в OBS. */
      monitor: z
        .object({
          enabled: z.boolean().default(false),
          deviceId: z.string().max(200).default(''),
          deviceLabel: z.string().max(200).default(''),
          volume: z.number().int().min(0).max(200).default(100)
        })
        .prefault({}),
      /** Компрессор: выравнивает громкость, чтобы крики капсом не рвали уши. */
      compressor: z.boolean().default(true)
    })
    .prefault({}),
  /** Горячие клавиши (формат Electron: Ctrl+Alt+S). Пусто - выключено. Работают и из игры. */
  hotkeys: z
    .object({
      skip: z.string().max(60).default('Ctrl+Alt+S'),
      pause: z.string().max(60).default('Ctrl+Alt+P'),
      toggle: z.string().max(60).default('Ctrl+Alt+T')
    })
    .prefault({}),
  /** Состояние интерфейса. wizardDone - мастер первого запуска пройден или закрыт. */
  ui: z
    .object({
      wizardDone: z.boolean().default(false)
    })
    .prefault({}),
  /** Мьюты зрителей (меняются отдельными командами, не через patch). */
  mutes: z.array(z.object({ login: z.string(), until: z.number() })).default([]),
  /** Секреты хранятся только зашифрованными (base64 от safeStorage). В renderer не уходят. */
  secrets: z
    .object({
      fishApiKey: z.string().nullable().default(null)
    })
    .prefault({})
})

export type Settings = z.infer<typeof settingsSchema>

/** Разделы, которые renderer может менять. Секреты и версия сюда не входят. */
export const PATCHABLE_SECTIONS = ['twitch', 'tts', 'filters', 'audio', 'hotkeys', 'ui'] as const

export type RolesSettings = FilterSettings['roles']

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Изменение настроек: любые вложенные поля по отдельности. Массивы заменяются целиком. */
export type SettingsPatch = DeepPartial<Pick<Settings, (typeof PATCHABLE_SECTIONS)[number]>>

/** Состояние ключа Fish для показа в UI (сам ключ в renderer не передаётся). */
export type SecretStatus = 'none' | 'ok' | 'unreadable'

/** Настройки, которые видит renderer. */
export type PublicSettings = Omit<Settings, 'secrets'> & {
  fishKey: SecretStatus
}

/** Приводит ввод канала к логину: "#Name", "twitch.tv/Name", "https://www.twitch.tv/name" -> "name". */
export function normalizeChannel(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.|m\.)?twitch\.tv\//, '')
  s = s.replace(/^#/, '')
  s = s.split(/[/?#]/)[0] ?? ''
  return s
}
