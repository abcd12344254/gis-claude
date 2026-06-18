import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      // OSM Nominatim 代理（解决 CORS）
      '/osm-nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/osm-nominatim/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('User-Agent', 'GISClaude/1.0 (gis-learning-tool)');
            proxyReq.setHeader('Accept', 'application/json');
          });
        },
      },
      // Overpass API 代理（解决 CORS）
      '/osm-overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/osm-overpass/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('User-Agent', 'GISClaude/1.0 (gis-learning-tool)');
          });
        },
      },
      // Wikidata API 代理（国内直连不通，通过 Vite 转发）
      '/wikidata-proxy': {
        target: 'https://www.wikidata.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/wikidata-proxy/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('User-Agent', 'GISClaude/1.0 (gis-learning-tool)');
          });
        },
      },
    },
  },
});
