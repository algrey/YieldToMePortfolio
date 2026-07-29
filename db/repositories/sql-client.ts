import { DatabaseSync } from "node:sqlite";

export type SqlRunResult = {
  changes: number;
  lastInsertRowId: number;
};

export type SqlClient = {
  all<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  get<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | undefined>;
  run(sql: string, params?: readonly unknown[]): Promise<SqlRunResult>;
};

function executeAll<T extends Record<string, unknown>>(
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): T[] {
  return database.prepare(sql).all(...(params as never[])) as T[];
}

function executeGet<T extends Record<string, unknown>>(
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): T | undefined {
  return database.prepare(sql).get(...(params as never[])) as T | undefined;
}

function executeRun(
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): SqlRunResult {
  const result = database.prepare(sql).run(...(params as never[])) as {
    changes: number;
    lastInsertRowid?: number;
  };

  return {
    changes: result.changes,
    lastInsertRowId: Number(result.lastInsertRowid ?? 0),
  };
}

export function createSqliteSqlClient(database: DatabaseSync): SqlClient {
  return {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      return executeAll<T>(database, sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T | undefined> {
      return executeGet<T>(database, sql, params);
    },
    async run(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<SqlRunResult> {
      return executeRun(database, sql, params);
    },
  };
}
