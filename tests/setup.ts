// Carga las variables de entorno desde .env antes de ejecutar los tests.
// El .env real no se versiona (está en .gitignore); ver .env.example.
import { config } from 'dotenv';

config();
