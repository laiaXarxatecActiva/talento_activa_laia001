// Alta del ADMIN inicial (staff). No hay registro público ni la API permite
// crear ADMIN: esta es la "operación aparte" para el primer administrador.
//
// Uso:  npm run create-admin -- admin@tu-dominio.com
// Pide la contraseña por terminal (sin mostrarla).
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { createDb } from '../src/model/db.js';
import { createInitialAdmin } from '../src/model/user.js';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (!muted || s.includes('\n')) out.output.write(muted ? '\n' : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

const email = process.argv[2];
if (!email) {
  console.error('Uso: npm run create-admin -- <email>');
  process.exit(1);
}

const password = await askHidden('Contraseña (12–256 caracteres): ');
const repeat = await askHidden('Repite la contraseña: ');
if (password !== repeat) {
  console.error('Las contraseñas no coinciden.');
  process.exit(1);
}

const sql = createDb();
try {
  const admin = await sql.begin((tx) => createInitialAdmin(tx, email, password));
  console.log(`ADMIN creado: ${admin.email} (${admin.id})`);
} catch (e) {
  console.error(`No se pudo crear el ADMIN: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
