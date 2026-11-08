import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias }
  },
  preload: {
    resolve: { alias },
    // Preload работает в песочнице (sandbox: true): там нельзя require() пакетов из node_modules,
    // поэтому всё собирается в один файл.
    build: { externalizeDeps: false }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()]
  }
})
