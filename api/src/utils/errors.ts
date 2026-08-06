/**
 * Traduction des erreurs Mongo/Mongoose en réponses JSON pour l'API mobile.
 * Une saisie refusée reste une erreur du client (400/409), seul l'imprévu
 * donne un 500.
 */

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export function describeApiError(err: unknown, conflictMessage: string): ApiError {
  const error = err as {
    code?: number;
    name?: string;
    errors?: Record<string, { message: string }>;
  };

  if (error?.code === 11000) {
    return { status: 409, code: 'CONFLICT', message: conflictMessage };
  }
  if (error?.name === 'ValidationError' && error.errors) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: Object.values(error.errors).map((e) => e.message).join(' ')
    };
  }
  return { status: 500, code: 'SERVER_ERROR', message: 'Erreur serveur.' };
}
