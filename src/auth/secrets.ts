export const RUNTIME_JWT_SECRET =
  process.env.RUNTIME_JWT_SECRET ??
  process.env.PORTAL_JWT_SECRET ??
  'unsafe-runtime-secret-change-in-production';
