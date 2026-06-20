import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
  },
})
