export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'La sesión no es válida o ha vencido.') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'No tienes permiso para realizar esta operación.') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'No se encontró el recurso solicitado.') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code, message) => new HttpError(409, code, message);
export const unprocessable = (code, message) => new HttpError(422, code, message);
