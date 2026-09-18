import { AppError } from '@comitiva/contract';

export function notImplemented(what: string): AppError {
  return new AppError('not_implemented', `${what} is not implemented yet`);
}

export function invalidRequest(message: string): AppError {
  return new AppError('invalid_request', message);
}
