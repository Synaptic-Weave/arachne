/**
 * Application-wide configuration helpers derived from environment variables.
 */

/**
 * Returns true when signups are enabled.
 * Signups are disabled only when SIGNUPS_ENABLED is explicitly set to "false".
 * Any other value (including unset) is treated as enabled.
 */
export function isSignupsEnabled(): boolean {
  return process.env.SIGNUPS_ENABLED !== 'false';
}
