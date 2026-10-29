import { z } from 'zod';

/**
 * Field errors keyed by JSON path, the last message per path, as the PoC keeps them
 * (Object.fromEntries over the zod issues) and as bff/internal/validation does.
 */
export const fieldErrorsOf = (schema: z.ZodTypeAny, input: unknown): Record<string, string> => {
  const result = schema.safeParse(input);
  if (result.success) return {};
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    out[issue.path.join('.')] = issue.message;
  }
  return out;
};

/**
 * The schema's message for a text field that has input but fails, so a disabled Next comes with a
 * reason. An empty field shows nothing, so a step never opens with errors. A number field passes
 * `Number` as `parse`.
 */
export const fieldMessage = (
  schema: z.ZodTypeAny,
  value: string,
  parse: (text: string) => unknown = (text) => text,
): string | undefined => {
  const result = value.trim() ? schema.safeParse(parse(value)) : undefined;
  return result && !result.success ? result.error.issues[0]?.message : undefined;
};

// Ported from krisv/ai-grid-cloud-provider-poc shared/tenant-validation.mjs at 62319b8.
// Adapted from OSAC tenant validation and IdentityProvider/CreateWizard validation.
const domainLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const tenantNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and hyphens.');
export const tenantDetailsSchema = z
  .object({
    name: tenantNameSchema,
    domains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .refine(
            (value) => value.split('.').length >= 2 && value.split('.').every((label) => domainLabel.test(label)),
            'Enter a valid domain, for example example.com.',
          ),
      )
      .max(64)
      .refine((domains) => new Set(domains).size === domains.length, 'Domains must be unique.'),
  })
  .strict();
const url = z
  .string()
  .trim()
  .max(2048)
  .url('Enter a valid HTTP or HTTPS URL.')
  .refine((value) => /^https?:\/\//.test(value), 'Use HTTP or HTTPS.');
const optionalUrl = z.union([z.literal(''), url]).default('');
export const oidcConfigSchema = z
  .object({
    clientId: z.string().trim().min(1, 'Client ID is required.').max(253),
    clientSecretSecret: z
      .object({
        name: z
          .string()
          .trim()
          .min(1, 'Client secret reference is required.')
          .max(253)
          .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Enter a valid secret reference name.'),
      })
      .strict(),
    issuer: url,
    authorizationUrl: url,
    tokenUrl: url,
    defaultScopes: z.string().trim().max(2048).default(''),
    userInfoUrl: optionalUrl,
    jwksUrl: optionalUrl,
    logoutUrl: optionalUrl,
    validateSignature: z.boolean().default(true),
  })
  .strict();
export const identityProviderSchema = z
  .object({
    title: z.string().trim().max(253).default(''),
    description: z.string().max(4000).default(''),
    enabled: z.literal(true).default(true),
    config: oidcConfigSchema,
  })
  .strict();
export const organizationInputSchema = tenantDetailsSchema
  .extend({ identityProvider: identityProviderSchema.optional() })
  .strict();
/** An identity provider form with nothing typed in it, which the organization form leaves out. */
export const isBlankIdentityProvider = ({ title, description, config }: z.input<typeof identityProviderSchema>) =>
  ![
    title,
    description,
    config.clientId,
    config.clientSecretSecret.name,
    config.issuer,
    config.authorizationUrl,
    config.tokenUrl,
    config.defaultScopes,
    config.userInfoUrl,
    config.jwksUrl,
    config.logoutUrl,
  ].some((v) => v?.trim());

// Ported from krisv/ai-grid-cloud-provider-poc shared/subscription-validation.mjs at 62319b8: the
// resource name rule, which the model rules share.
export const resourceName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);

// Ported from krisv/ai-grid-cloud-provider-poc shared/model-validation.mjs at 62319b8.
export const modelNameSchema = resourceName.max(63);
export const locationSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/, 'Use a Kubernetes label value for the location.');
export const locationsSchema = z
  .array(locationSchema)
  .max(64)
  .refine((values) => new Set(values).size === values.length, 'Locations must be unique.');
export const createModelSchema = z
  .object({
    name: modelNameSchema,
    displayName: z.string().trim().min(1).max(253),
    description: z.string().max(4000).optional(),
    modelUri: z
      .string()
      .trim()
      .max(2048)
      .regex(/^(hf|oci|s3|pvc):\/\/[^\s]+$/, 'Enter a model URI using hf, oci, s3 or pvc.'),
    modelName: z.string().trim().min(1).max(253),
    runtimeImage: z.string().trim().min(1).max(2048).regex(/^\S+$/, 'Enter a container image without spaces.'),
    replicas: z.number().int().min(1).max(99),
    cpu: z
      .string()
      .regex(
        /^(?:[1-9]\d*|0\.[0-9]*[1-9]\d*|[1-9]\d*\.\d+|[1-9]\d*m)$/,
        'Enter positive CPU cores or millicores, for example 2 or 500m.',
      ),
    memory: z.string().regex(/^[1-9]\d*(?:Mi|Gi|Ti)$/, 'Enter memory such as 4Gi or 512Mi.'),
    gpuCount: z.number().int().min(0).max(64),
    runtimeArgs: z.array(z.string().max(4096)).max(64),
    baseRefs: z.array(z.string().min(1, 'Enter a preset name.').max(253)).max(8),
    locations: locationsSchema.refine((values) => values.length > 0, 'Select at least one location.'),
  })
  .strict();

/** One validator per schema name in mock/validation/cases.json. */
export const validators = {
  organization: (input: unknown) => fieldErrorsOf(organizationInputSchema, input),
  model: (input: unknown) => fieldErrorsOf(createModelSchema, input),
};
