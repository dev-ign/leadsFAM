import { z } from 'zod';

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof roleSchema>;
export const permissions = {
  owner: [
    'read',
    'write_note',
    'settings',
    'invite_member',
    'invite_admin',
    'remove_member',
    'change_role',
    'moderate_note',
    'crm_write',
    'crm_manage',
    'crm_import',
  ],
  admin: [
    'read',
    'write_note',
    'settings',
    'invite_member',
    'remove_member',
    'moderate_note',
    'crm_write',
    'crm_manage',
    'crm_import',
  ],
  member: ['read', 'write_note', 'crm_write'],
} as const;
export type Permission = (typeof permissions)[Role][number];
export function can(role: Role, permission: Permission) {
  return (permissions[role] as readonly Permission[]).includes(permission);
}
// Presentation helpers mirror target-role restrictions; database RPCs remain authoritative.
export function canRemoveMember(actor: Role, target: Role, self: boolean) {
  return (
    target !== 'owner' && (self || actor === 'owner' || (actor === 'admin' && target === 'member'))
  );
}
export function canChangeMemberRole(actor: Role, target: Role) {
  return can(actor, 'change_role') && target !== 'owner';
}
export const emailSchema = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase().trim());
export const passwordSchema = z.string().min(12).max(128);
export const credentialsSchema = z.strictObject({ email: emailSchema, password: passwordSchema });
export const signupSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(100),
});
export const emailRequestSchema = z.strictObject({ email: emailSchema });
export const otpSchema = emailRequestSchema.extend({ token: z.string().regex(/^\d{6}$/) });
export const passwordRequestSchema = z.strictObject({ password: passwordSchema });
export const okSchema = z.strictObject({ ok: z.literal(true) });
export const sessionSchema = z.strictObject({
  csrfToken: z.string().min(32),
  purpose: z.enum(['anonymous', 'recovery', 'application']),
  user: z.strictObject({ id: z.uuid(), email: z.email() }).nullable(),
  onboardingEnabled: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;
export const organizationSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  role: roleSchema,
});
export type Organization = z.infer<typeof organizationSchema>;
export const organizationsSchema = z.array(organizationSchema);
export const organizationNameSchema = z.strictObject({ name: z.string().trim().min(1).max(80) });
export const orgParamsSchema = z.strictObject({ org: z.uuid() });
export const memberParamsSchema = orgParamsSchema.extend({ user: z.uuid() });
export const resourceParamsSchema = orgParamsSchema.extend({ id: z.uuid() });
export const membersSchema = z.array(
  z.strictObject({
    userId: z.uuid(),
    displayName: z.string(),
    role: roleSchema,
    revoked: z.boolean(),
  }),
);
export const memberChangeSchema = z.strictObject({ role: z.enum(['admin', 'member']) });
export const invitationRequestSchema = z.strictObject({
  email: emailSchema,
  role: z.enum(['admin', 'member']),
});
export const invitationAcceptSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const invitationsSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    email: z.email(),
    role: z.enum(['admin', 'member']),
    expiresAt: z.string(),
    accepted: z.boolean(),
    revoked: z.boolean(),
  }),
);
export const invitationCreatedSchema = z.strictObject({ id: z.uuid(), token: z.string() });
export const noteInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(4000),
});
export const noteSchema = z.strictObject({
  id: z.uuid(),
  organizationId: z.uuid(),
  authorId: z.uuid(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});
export const notesSchema = z.array(noteSchema);
export type Note = z.infer<typeof noteSchema>;
