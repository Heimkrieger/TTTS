# Посредник для отзывов

Программа отправляет отчёт "Сообщить о проблеме" сюда, посредник пересылает его в Telegram
автору. Ключ бота хранится только здесь (секрет Cloudflare), в открытом коде программы его нет.
Посредник ничего не сохраняет: ни отчёты, ни IP отправителя. IP используется только
встроенным ограничением Cloudflare (не чаще 1 отчёта в минуту с адреса). Отчёты остаются в
чате Telegram с ботом.

## Что нужно один раз

1. Бот: в Telegram написать @BotFather, команда `/newbot`, сохранить ключ бота.
2. Свой id чата: написать боту любое сообщение, открыть
   `https://api.telegram.org/bot<ключ>/getUpdates`, взять `message.chat.id`.
3. Аккаунт Cloudflare (бесплатный).

## Выкладка

```
cd feedback-relay
npx wrangler login
npx wrangler secret put TG_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler deploy
```

После выкладки Cloudflare покажет адрес вида `https://tts-feedback.<имя>.workers.dev`.
В программе его задать в `src/shared/brand.ts`: `FEEDBACK_URL = 'https://tts-feedback.<имя>.workers.dev/report'`.

## Проверка

```
curl -X POST https://tts-feedback.<имя>.workers.dev/report -H "Content-Type: application/json" -d "{\"kind\":\"bug\",\"text\":\"проверка связи\",\"appVersion\":\"0.0.1\",\"os\":\"Windows\",\"contact\":\"\",\"log\":\"\"}"
```

Ответ `{"ok":true}` и сообщение в Telegram - всё работает.
