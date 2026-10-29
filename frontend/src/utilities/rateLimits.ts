// Ported from krisv/ai-grid-cloud-provider-poc src/app/utilities/rateLimits.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/utilities/rateLimits.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { z } from 'zod';

/**
 * A subscription's token limit: TokenRateLimit with its int64 limit as a number, which
 * validateSubscriptionSpec (the backend's internal/servers/subscriptions_server.go) caps at 1e9.
 */
export type TokenLimit = { limit: number; window: string };

/**
 * A token limit as the form edits it: count tokens per time unit(s). savedWindow is the window it
 * was loaded with when the form could not read it (see toRateLimit).
 */
export type RateLimit = { count: number; time: number; unit: 'hour' | 'minute' | 'second'; savedWindow?: string };

const WINDOW_SUFFIX_TO_UNIT: Record<string, RateLimit['unit']> = {
  s: 'second',
  m: 'minute',
  h: 'hour',
};

const UNIT_TO_WINDOW_SUFFIX: Record<RateLimit['unit'], string> = {
  second: 's',
  minute: 'm',
  hour: 'h',
};

/**
 * The windows a MaaSSubscription accepts: a whole number from 1 to 9999 and one unit, s, m or h
 * ("Days (d) are not supported; use hours instead"). This is the CRD's pattern for
 * spec.modelRefs[].tokenRateLimits[].window (opendatahub-io/models-as-a-service
 * maas-controller/api/maas/v1alpha1/maassubscription_types.go at 4d71db2, as served by the
 * dev hub), and the backend refuses any other window on a write.
 */
const WINDOW_PATTERN = /^([1-9]\d{0,3})([smh])$/;

export const formatLocaleNumber = (value: number): string => value.toLocaleString('en-US');

export const UNIT_OPTIONS: { value: RateLimit['unit']; label: string }[] = [
  { value: 'hour', label: 'hour' },
  { value: 'minute', label: 'minute' },
  { value: 'second', label: 'second' },
];

/** Reads a window such as "24h" or "30m"; undefined for anything the CRD does not accept. */
export const parseWindow = (window: string): { time: number; unit: RateLimit['unit'] } | undefined => {
  const match = WINDOW_PATTERN.exec(window);
  return match ? { time: parseInt(match[1], 10), unit: WINDOW_SUFFIX_TO_UNIT[match[2]] } : undefined;
};

/** Shows a window as "1 hour" or "24 hours"; a window it cannot read is shown as it is. */
export const formatWindow = (window: string): string => {
  const parsed = parseWindow(window);
  if (!parsed) return window;
  return `${formatLocaleNumber(parsed.time)} ${parsed.unit}${parsed.time === 1 ? '' : 's'}`;
};

export const formatTokenRateLimitLine = (limit: number, window: string): string =>
  `${formatLocaleNumber(limit)} / ${formatWindow(window)}`;

/**
 * Converts a TokenLimit to the UI's RateLimit form. A window the form cannot read gets no
 * time, rather than a guess, and keeps the saved window so the form can name it.
 */
export const toRateLimit = (trl: TokenLimit): RateLimit => {
  const parsed = parseWindow(trl.window);
  return parsed
    ? { count: trl.limit, time: parsed.time, unit: parsed.unit }
    : { count: trl.limit, time: NaN, unit: 'hour', savedWindow: trl.window };
};

/** Names a limit's saved window that the form could not read, while its time is not valid yet. */
export const getSavedWindowMessage = (limit: RateLimit): string | undefined =>
  limit.savedWindow !== undefined && getTimeError(limit) !== undefined
    ? `Saved as "${limit.savedWindow}", which MaaS doesn't accept. Enter a time from 1 to 9999.`
    : undefined;

/** Converts the UI's RateLimit form back to a TokenLimit. */
export const toTokenRateLimit = (rl: RateLimit): TokenLimit => ({
  limit: rl.count,
  window: `${rl.time}${UNIT_TO_WINDOW_SUFFIX[rl.unit]}`,
});

export const DEFAULT_RATE_LIMIT: RateLimit = { count: 1000, time: 1, unit: 'hour' };
export const MAX_VALUE = 1_000_000_000;
export const MAX_WINDOW_VALUE = 9_999;

export const exceedsTokenLimit = (n: number): boolean => !Number.isNaN(n) && Math.trunc(Math.abs(n)) > MAX_VALUE;

/**
 * The longest window MaaS applies, 366 days. The CRD admits up to 9999h, but the MaaS controller
 * refuses a window over 366 * 24 * 3600 seconds and leaves the subscription out of the model's
 * TokenRateLimitPolicy (maxWindowSeconds and validateTokenRateLimit in
 * opendatahub-io/models-as-a-service maas-controller/pkg/controller/maas/maassubscription_controller.go
 * at 4d71db2), so the backend refuses it on a write (maxTokenWindowSeconds in
 * ai-grid-provider-backend internal/servers/subscription_mapper.go). Only hours can
 * reach it: 9999m and 9999s are shorter.
 */
export const MAX_WINDOW_HOURS = 8_784;

export const exceedsWindowLimit = (n: number): boolean =>
  !Number.isNaN(n) && Math.trunc(Math.abs(n)) > MAX_WINDOW_VALUE;

const exceedsMaxWindowHours = (limit: RateLimit): boolean => limit.unit === 'hour' && limit.time > MAX_WINDOW_HOURS;

export const rateLimitExceedsMaxDigits = (limit: RateLimit): boolean =>
  exceedsTokenLimit(limit.count) || exceedsWindowLimit(limit.time) || exceedsMaxWindowHours(limit);

export const rateLimitSchema = z.object({
  count: z
    .number()
    .int()
    .min(1, 'Token count must be greater than 0')
    .max(MAX_VALUE, 'Token count exceeds maximum allowed value'),
  time: z
    .number()
    .int()
    .min(1, 'Time value must be greater than 0')
    .max(MAX_WINDOW_VALUE, 'Time value exceeds maximum allowed value'),
  unit: z.enum(['hour', 'minute', 'second']),
});

export const rateLimitsSchema = z.array(rateLimitSchema).min(1, 'At least one token rate limit is required');

export const getCountError = (limit: RateLimit): string | undefined => {
  if (Number.isNaN(limit.count)) {
    return 'Token count is required';
  }
  const result = rateLimitSchema.shape.count.safeParse(limit.count);
  return result.success ? undefined : result.error.issues[0].message;
};

export const getTimeError = (limit: RateLimit): string | undefined => {
  if (Number.isNaN(limit.time)) {
    return 'Time value is required';
  }
  const result = rateLimitSchema.shape.time.safeParse(limit.time);
  return result.success ? undefined : result.error.issues[0].message;
};

export const getCountDigitError = (limit: RateLimit): string | undefined =>
  exceedsTokenLimit(limit.count) ? 'Token count exceeds maximum allowed value' : undefined;

/** The time's too-large error, shown as soon as it is typed: over 8784 hours, or over 4 digits. */
export const getTimeDigitError = (limit: RateLimit): string | undefined => {
  if (exceedsMaxWindowHours(limit)) return `At most ${MAX_WINDOW_HOURS} hours (366 days)`;
  return exceedsWindowLimit(limit.time) ? 'Time value exceeds maximum allowed value' : undefined;
};
