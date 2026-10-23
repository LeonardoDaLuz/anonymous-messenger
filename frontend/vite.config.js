import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const basePath = '/anonymous-messenger';

export default defineConfig({
  base: `${basePath}/`,
  plugins: [react()],
  server: {
    proxy: {
      [`${basePath}/api`]: {
        target: 'http://localhost:3000',
        rewrite: (path) => path.slice(basePath.length),
      },
      [`${basePath}/ws`]: {
        target: 'ws://localhost:3000',
        ws: true,
        rewrite: (path) => path.slice(basePath.length),
      },
    },
  },
});
