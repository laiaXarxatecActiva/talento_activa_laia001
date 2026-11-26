// Punto de entrada: solo cablea dependencias y arranca el servidor HTTP.
// La lógica vive (y se prueba) en src/controller y src/model.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './controller/app.js';
import { createDb } from './model/db.js';

const sql = createDb();
const app = createApp({ transaction: (work) => sql.begin(work) });
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API escuchando en http://localhost:${info.port}`);
});
