import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'public/manifest.json', dest: '' },
        { src: 'public/icons', dest: '' },
        { src: 'public/offscreen.html', dest: '' },
      ],
    }),
    {
      name: 'generate-html',
      closeBundle() {
        const sidepanelHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chrome AI Assistant</title>
  <script type="module" crossorigin src="/sidepanel/index.js"></script>
  <link rel="stylesheet" crossorigin href="/sidepanel/sidepanel.css">
</head>
<body>
  <div id="root"></div>
</body>
</html>`;
        fs.mkdirSync(path.join(__dirname, 'dist/sidepanel'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, 'dist/sidepanel/index.html'), sidepanelHtml);

        const optionsHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chrome AI Assistant - Settings</title>
  <script type="module" crossorigin src="/options/index.js"></script>
  <link rel="stylesheet" crossorigin href="/options/options.css">
</head>
<body>
  <div id="root"></div>
</body>
</html>`;
        fs.mkdirSync(path.join(__dirname, 'dist/options'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, 'dist/options/index.html'), optionsHtml);
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        background: path.resolve(__dirname, 'src/background/index.ts'),
        'content-script': path.resolve(__dirname, 'src/content-script/index.ts'),
        sidepanel: path.resolve(__dirname, 'src/sidepanel/main.tsx'),
        options: path.resolve(__dirname, 'src/options/main.tsx'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          const name = chunkInfo.name;
          if (name === 'sidepanel') return 'sidepanel/index.js';
          if (name === 'options') return 'options/index.js';
          return `${name}/index.js`;
        },
        chunkFileNames: '[name]/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return '[name]/[name].[ext]';
          }
          return '[name]/[name]-[hash].[ext]';
        },
        // Don't split entry points - inline everything
        manualChunks: (id) => {
          // Don't split entry points
          if (id.includes('src/sidepanel/main.tsx') || id.includes('src/options/main.tsx')) {
            return;
          }
          // Don't split shared code between sidepanel and options
          if (id.includes('src/sidepanel/') || id.includes('src/options/')) {
            return;
          }
          // Put vendor in separate chunk
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        },
      },
    },
  },
});
