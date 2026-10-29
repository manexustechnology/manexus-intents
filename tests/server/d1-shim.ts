import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "../../server/db.ts";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** A test database that also counts D1 queries: each executed statement is one, a `batch()` is one (D1's per-invocation limit). */
export type TestDb = Db & { queries: number };

export function createTestDb(): TestDb {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(migrationsDir + f, "utf8"));
  }
  // Statements created by this shim run synchronously; batch() replays them inside BEGIN/COMMIT like D1.
  const runners = new WeakMap<object, () => { meta: { changes: number } }>();
  const db: TestDb = {
    queries: 0,
    async batch(stmts) {
      db.queries++;
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const run = runners.get(s);
          if (!run) throw new Error("batch() needs statements from this database");
          return run();
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...v: unknown[]) {
          const params = v as never[];
          const runSync = () => ({ meta: { changes: Number(stmt.run(...params).changes) } });
          const bound = {
            async first<T>() {
              db.queries++;
              return ((stmt.get(...params) as T | undefined) ?? null);
            },
            async all<T>() {
              db.queries++;
              return { results: stmt.all(...params) as T[] };
            },
            async run() {
              db.queries++;
              return runSync();
            },
          };
          runners.set(bound, runSync);
          return bound;
        },
      };
    },
  };
  return db;
}
