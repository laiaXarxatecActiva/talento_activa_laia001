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

/**
 * Conflicto con el estado actual (p. ej. email ya registrado). El mensaje por
 * defecto es genérico a propósito (anti-enumeración). El controlador → 409.
 */
export class ConflictError extends Error {
  constructor(message = 'No se ha podido completar el registro') {
    super(message);
    this.name = 'ConflictError';
  }
}
