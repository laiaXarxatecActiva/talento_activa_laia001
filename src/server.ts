// Punto de entrada: solo cablea dependencias y arranca el servidor HTTP.
// La lógica vive (y se prueba) en src/controller y src/model.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './controller/app.js';
import { createDb } from './model/db.js';
import { createResendSender, type EmailSender } from './model/email.js';
import { createSupabaseStorage, type Storage } from './model/storage.js';

const isSet = (v: string | undefined): v is string => !!v && v.trim() !== '' && !v.includes('<');

const sql = createDb();

// Con RESEND_API_KEY real se envía por Resend; si no, los emails salen por
// consola (útil en desarrollo para copiar el enlace de verificación).
let email: EmailSender | undefined;
if (isSet(process.env.RESEND_API_KEY)) {
  email = createResendSender({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM ?? 'Xarxatec Activa <onboarding@resend.dev>',
  });
} else {
  console.warn('RESEND_API_KEY sin configurar: los emails se mostrarán por consola.');
}

// Supabase Storage para las miniaturas; sin configurar, las subidas → 503.
let storage: Storage | undefined;
if (isSet(process.env.SUPABASE_URL) && isSet(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  storage = createSupabaseStorage({
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'media',
  });
} else {
  console.warn('Supabase Storage sin configurar: la subida de miniaturas responderá 503.');
}

const app = createApp({ transaction: (work) => sql.begin(work), email, storage });
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API escuchando en http://localhost:${info.port}`);
});
