import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import 'dotenv/config';

// Vi mounter Hono som Vite-middleware. Da kjører frontend og backend
// på samme port (3000), og vi slipper CORS-styr.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'hono-middleware',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          // Bare API-ruter går til Hono. Resten serveres av Vite (React).
          const url = req.url || '';
          if (!url.startsWith('/api') && !url.startsWith('/auth')) {
            return next();
          }
          const { app } = await server.ssrLoadModule('/server/index.ts');
          // Konverter Node-request til Web Request for Hono
          const protocol = (req.socket as any).encrypted ? 'https' : 'http';
          const host = req.headers.host || 'localhost:3000';
          const fullUrl = `${protocol}://${host}${url}`;

          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(','));
          }

          let body: BodyInit | undefined;
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            body = Buffer.concat(chunks);
          }

          const honoRes: Response = await app.fetch(
            new Request(fullUrl, {
              method: req.method,
              headers,
              body,
            }),
          );

          res.statusCode = honoRes.status;
          honoRes.headers.forEach((value, key) => res.setHeader(key, value));
          const buf = Buffer.from(await honoRes.arrayBuffer());
          res.end(buf);
        });
      },
    },
  ],
  server: {
    port: Number(process.env.PORT) || 3000,
  },
});
