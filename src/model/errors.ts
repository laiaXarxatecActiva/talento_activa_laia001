/**
 * Datos de entrada no válidos (p. ej. contraseña fuera de rango).
 * El controlador lo traducirá a una respuesta 400.
 */
export class InvalidDataError extends Error {
  constructor(message = 'Datos no válidos') {
    super(message);
    this.name = 'InvalidDataError';
  }
}
