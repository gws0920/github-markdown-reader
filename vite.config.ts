import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/github-markdown-reader/',
  plugins: [react()],
})
