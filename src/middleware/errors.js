import { HttpError } from '../lib/errors.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ data: null, message: 'La ruta solicitada no existe.', code: 'ROUTE_NOT_FOUND' });
}

export function errorHandler(error, req, res, _next) {
  if (res.headersSent) return;
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Ocurrió un error interno. Inténtalo nuevamente.';
  if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (error?.name === 'MulterError') {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = error.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_TOO_LARGE' : 'INVALID_UPLOAD';
    message = error.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera el tamaño permitido.' : 'No se pudo procesar la imagen.';
  } else if (error?.code === 'ENOENT' && Number(error?.status) === 404) {
    status = 404; code = 'NOT_FOUND'; message = 'No se encontró el recurso solicitado.';
  } else if (error?.type === 'entity.too.large') {
    status = 413; code = 'BODY_TOO_LARGE'; message = 'La solicitud supera el tamaño permitido.';
  } else if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError && 'body' in error) {
    status = 400; code = 'INVALID_JSON'; message = 'El contenido JSON no es válido.';
  }
  if (status >= 500) {
    console.error(JSON.stringify({ level: 'error', requestId: req.id, path: req.path, method: req.method, errorName: error?.name, errorCode: error?.code }));
  }
  res.status(status).json({ data: null, message, code });
}
