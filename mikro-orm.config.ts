/**
 * MikroORM CLI configuration.
 *
 * Used by `npx mikro-orm` commands (migration:create, migration:up, etc.).
 * Delegates to the shared buildOrmConfig() so runtime and CLI always agree.
 *
 * Requires `dotenv` to load .env before MikroORM reads DATABASE_URL.
 */
import 'dotenv/config';
import { buildOrmConfig } from './src/orm.js';

export default buildOrmConfig();
