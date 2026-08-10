import type {
  SqlBatchResult,
  SqlClient,
  SqlStatement,
} from "./repositories/sql-client";

export async function getSqlClient(): Promise<SqlClient> {
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env as typeof env & {
    DB?: D1Database;
    YIELDTOME_RUNTIME_ENV?: unknown;
    YIELDTOME_DEV_D1_TX_SHIM?: unknown;
  };
  if (!runtimeEnv.DB)
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");

  const client = createD1SqlClient(runtimeEnv.DB);

  // LOCAL-DEV ONLY, TEMPORARY. Several repositories wrap multi-statement work in
  // `BEGIN IMMEDIATE TRANSACTION`/`COMMIT`, which Cloudflare D1 rejects
  // ("please use the transaction() APIs instead of SQL BEGIN"). That breaks CSV
  // import and other write paths on real D1. This shim neutralizes those
  // transaction-control statements locally so the app is testable end to end;
  // statements then autocommit individually (NOT atomic). It is double-gated:
  // it only activates in the `local` runtime AND when the explicit opt-in var
  // `YIELDTOME_DEV_D1_TX_SHIM=enabled` is set (see `.dev.vars`), so it can never
  // affect preview or production. Remove this together with the real fix.
  // Tracked by QA-003 in TASKS.md.
  if (
    runtimeEnv.YIELDTOME_RUNTIME_ENV === "local" &&
    runtimeEnv.YIELDTOME_DEV_D1_TX_SHIM === "enabled"
  ) {
    return wrapWithLocalDevTransactionShim(client);
  }

  return client;
}

/**
 * LOCAL-DEV ONLY. See the gated call site in `getSqlClient`. Swallows
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/`RELEASE` so D1 does not reject them;
 * every other statement passes through unchanged and autocommits.
 */
function wrapWithLocalDevTransactionShim(client: SqlClient): SqlClient {
  const isTransactionControl = (sql: string): boolean =>
    /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql);

  return {
    all: client.all.bind(client),
    get: client.get.bind(client),
    async run(sql: string, params: readonly unknown[] = []) {
      if (isTransactionControl(sql)) {
        return { changes: 0, lastInsertRowId: 0 };
      }
      return client.run(sql, params);
    },
    batch: client.batch ? client.batch.bind(client) : undefined,
  };
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
