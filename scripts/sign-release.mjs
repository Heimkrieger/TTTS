// Подпись архива релиза для обновлений программы.
// Берёт закрытый ключ из переменной UPDATE_SIGN_KEY (PEM, в GitHub Actions - секрет) или из файла
// по пути UPDATE_SIGN_KEY_FILE, находит архив release/<версия>/*-win-x64.zip и пишет рядом:
//   <архив>.sig    - подпись Ed25519 строки SHA-256 архива (base64), её проверяет программа;
//   <архив>.sha256 - контрольная сумма для людей (и для проверки на VirusTotal).
// Запуск: node scripts/sign-release.mjs
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const dir = join('release', pkg.version)
const zip = readdirSync(dir).find((f) => f.endsWith('-win-x64.zip'))
if (!zip) {
  console.error(`нет архива в ${dir}: сначала npm run release:zip`)
  process.exit(1)
}
const pem =
  process.env.UPDATE_SIGN_KEY ||
  (process.env.UPDATE_SIGN_KEY_FILE ? readFileSync(process.env.UPDATE_SIGN_KEY_FILE, 'utf8') : '')
if (!pem) {
  console.error('нет ключа подписи: задайте UPDATE_SIGN_KEY или UPDATE_SIGN_KEY_FILE')
  process.exit(1)
}
const file = join(dir, zip)
const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
const sig = sign(null, Buffer.from(hash), createPrivateKey(pem)).toString('base64')
writeFileSync(`${file}.sig`, sig + '\n')
writeFileSync(`${file}.sha256`, `${hash}  ${zip}\n`)
console.log(`подписано: ${zip}\nSHA-256: ${hash}`)
