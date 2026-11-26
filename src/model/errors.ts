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

/**
 * Login fallido. Mismo mensaje exista o no el email (anti-enumeración).
 * El controlador → 401.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Credenciales no válidas');
    this.name = 'InvalidCredentialsError';
  }
}

/** Recurso inexistente (o que el actor no puede ver). El controlador → 404. */
export class NotFoundError extends Error {
  constructor(message = 'No encontrado') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Fallo del proveedor de email. El controlador → 502. */
export class EmailDeliveryError extends Error {
  constructor() {
    super('No se ha podido enviar el email');
    this.name = 'EmailDeliveryError';
  }
}
