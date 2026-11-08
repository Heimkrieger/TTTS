// Текст релиза для GitHub: раздел "## <версия>" из CHANGELOG.md. Его же программа показывает
// в окне обновления. Запуск: node scripts/release-notes.mjs > release/notes.md
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const log = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n')
const start = log.indexOf(`## ${version}`)
if (start < 0) {
  console.error(`в CHANGELOG.md нет раздела "## ${version}": опишите, что нового`)
  process.exit(1)
}
const rest = log.slice(start).split('\n').slice(1)
const end = rest.findIndex((l) => l.startsWith('## '))
process.stdout.write((end < 0 ? rest : rest.slice(0, end)).join('\n').trim() + '\n')
