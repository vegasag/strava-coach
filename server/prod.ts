import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app } from './index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../dist');

// Serve static files from Vite build output
app.use('/*', serveStatic({ root: './dist' }));

// SPA fallback: serve index.html for all non-API routes
app.get('*', (c) => {
  const html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
  return c.html(html);
});

const port = Number(process.env.PORT) || 3000;
console.log(`Strava Coach running on port ${port}`);
serve({ fetch: app.fetch, port });
