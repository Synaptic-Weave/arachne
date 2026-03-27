import { MikroORM, type Options } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { BetterSqliteDriver } from '@mikro-orm/better-sqlite';
import { Migrator } from '@mikro-orm/migrations';
import { allSchemas } from './domain/schemas/index.js';

const DRIVER_MAP = {
  postgres: PostgreSqlDriver,
  sqlite: BetterSqliteDriver,
} as const;

type DriverType = keyof typeof DRIVER_MAP;

/**
 * Build the shared MikroORM configuration object.
 * Exported so that mikro-orm.config.ts (CLI entry point) can reuse it.
 */
export function buildOrmConfig(overrides?: Partial<Options>): Options {
  const driverType = (process.env.DB_DRIVER ?? 'postgres') as DriverType;
  const driver = DRIVER_MAP[driverType] ?? PostgreSqlDriver;

  const clientUrl =
    process.env.DATABASE_URL ?? 'postgres://loom:loom_dev_password@localhost:5432/loom';
  const useSSL = clientUrl.includes('sslmode=require') || clientUrl.includes('sslmode=verify');

  return {
    driver,
    clientUrl,
    entities: allSchemas,
    debug: process.env.NODE_ENV === 'development',
    extensions: [Migrator],
    migrations: {
      path: './src/migrations',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: true,
      emit: 'ts',
    },
    ...(useSSL && driverType === 'postgres'
      ? { driverOptions: { connection: { ssl: { rejectUnauthorized: false } } } }
      : {}),
    ...overrides,
  };
}

export async function initOrm(overrides?: Partial<Options>): Promise<MikroORM> {
  const config = buildOrmConfig(overrides);
  const instance = await MikroORM.init(config);
  orm = instance;
  return instance;
}

// eslint-disable-next-line prefer-const
export let orm: MikroORM;
