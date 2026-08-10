import type {
  SqlBatchResult,
  SqlClient,
  SqlStatement,
} from "./repositories/sql-client";

export async function getSqlClient(): Promise<SqlClient> {
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env as typeof env & { DB?: D1Database };
  if (!runtimeEnv.DB)
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");

  return createD1SqlClient(runtimeEnv.DB);
}

/** D1 adapter exported for synthetic Miniflare drills without runtime globals. */
export function createD1SqlClient(database: D1Database): SqlClient {
  return {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      return (
        await database
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      return (
        (await database
          .prepare(sql)
          .bind(...params)
          .first<T>()) ?? undefined
      );
    },
    async run(sql: string, params: readonly unknown[] = []) {
      const result = await database
        .prepare(sql)
        .bind(...params)
        .run();
      return {
        changes: result.meta.changes,
        lastInsertRowId: result.meta.last_row_id,
      };
    },
    async batch(
      statements: readonly SqlStatement[],
    ): Promise<SqlBatchResult[]> {
      const results = await database.batch(
        statements.map((statement) =>
          database.prepare(statement.sql).bind(...(statement.params ?? [])),
        ),
      );
      return results.map((result) => ({
        changes: result.meta.changes,
        lastInsertRowId: result.meta.last_row_id,
        results: result.results as Array<Record<string, unknown>>,
      }));
    },
  };
}
