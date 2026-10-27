import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const basePath = '/anonymous-messenger';
const buildId = Date.now().toString(36);

// Publica o id do build em version.json; a página compara com o id embutido nela para saber se há versão nova.
const versionFile = {
  name: 'version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: buildId }) });
  },
};

export default defineConfig({
  base: `${basePath}/`,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), versionFile],
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
