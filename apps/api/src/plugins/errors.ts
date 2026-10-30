import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IdentityFailure } from '../modules/identity/failure.js';
import type { ApiErrorResponse } from '@leadops/shared';

function respond(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
) {
  const body: ApiErrorResponse = { error: { code, message, requestId: request.id } };
  return reply.code(status).send(body);
}
export function registerErrorHandlers(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) =>
    respond(reply, request, 404, 'NOT_FOUND', 'Route not found.'),
  );
  app.setErrorHandler((error, request, reply) => {
    const failure = error instanceof Error ? error : new Error('Unknown failure');
    if (failure instanceof IdentityFailure)
      return respond(
        reply,
        request,
        failure.statusCode,
        failure.code,
        (
          {
            SIGN_IN_REQUIRED: 'Sign in to continue.',
            CREDENTIALS_REJECTED: 'The credentials could not be verified.',
            NOT_FOUND: 'The requested resource is unavailable.',
            FORBIDDEN: 'You do not have permission for this action.',
            RATE_LIMITED: 'Too many attempts. Please try again later.',
          } as Record<string, string>
        )[failure.code] ?? 'The request could not be completed.',
      );
    const status = 'statusCode' in failure ? failure.statusCode : undefined;
    if ('validation' in failure && failure.validation)
      return respond(
        reply,
        request,
        400,
        'INVALID_REQUEST',
        'The request does not match the expected format.',
      );
    if (status === 429)
      return respond(
        reply,
        request,
        429,
        'RATE_LIMITED',
        'Too many attempts. Please try again later.',
      );
    if (status === 413)
      return respond(reply, request, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
    if (status === 415)
      return respond(
        reply,
        request,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'The request content type is unsupported.',
      );
    if (status === 400)
      return respond(reply, request, 400, 'INVALID_REQUEST', 'The request could not be processed.');
    request.log.error(
      { errorType: failure.name, errorCode: 'code' in failure ? failure.code : undefined },
      'Request failed',
    );
    return respond(reply, request, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  });
}
