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

  return {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      return (
        await runtimeEnv
          .DB!.prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      return (
        (await runtimeEnv
          .DB!.prepare(sql)
          .bind(...params)
          .first<T>()) ?? undefined
      );
    },
    async run(sql: string, params: readonly unknown[] = []) {
      const result = await runtimeEnv
        .DB!.prepare(sql)
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
      const results = await runtimeEnv.DB!.batch(
        statements.map((statement) =>
          runtimeEnv
            .DB!.prepare(statement.sql)
            .bind(...(statement.params ?? [])),
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
