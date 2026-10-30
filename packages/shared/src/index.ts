import { z } from 'zod';

export const healthQuerySchema = z.strictObject({});
export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('leadops-api'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), requestId: z.string() }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
