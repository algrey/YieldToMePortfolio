import { DatabaseSync } from "node:sqlite";

export type SqlRunResult = {
  changes: number;
  lastInsertRowId: number;
};

export type SqlStatement = {
  sql: string;
  params?: readonly unknown[];
};

export type SqlBatchResult = SqlRunResult & {
  results: Array<Record<string, unknown>>;
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
  /**
   * Executes statements as one atomic unit, matching Cloudflare D1's
   * `D1Database.batch()` semantics (D1 rejects SQL-level `BEGIN`/`COMMIT`/
   * `ROLLBACK`, so `batch()` is the only supported atomic primitive). Every
   * `SqlClient` implementation must provide this; repositories rely on it
   * unconditionally instead of falling back to SQL transaction control.
   */
  batch(statements: readonly SqlStatement[]): Promise<SqlBatchResult[]>;
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
    async batch(
      statements: readonly SqlStatement[],
    ): Promise<SqlBatchResult[]> {
      database.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const results = statements.map((statement) => ({
          results: executeAll<Record<string, unknown>>(
            database,
            statement.sql,
            statement.params ?? [],
          ),
          changes: 0,
          lastInsertRowId: 0,
        }));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
