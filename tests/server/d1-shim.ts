import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "../../server/db.ts";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

export function createTestDb(): Db {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(migrationsDir + f, "utf8"));
  }
  // Statements created by this shim run synchronously; batch() replays them inside BEGIN/COMMIT like D1.
  const runners = new WeakMap<object, () => { meta: { changes: number } }>();
  return {
    async batch(stmts) {
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
              return ((stmt.get(...params) as T | undefined) ?? null);
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[] };
            },
            async run() {
              return runSync();
            },
          };
          runners.set(bound, runSync);
          return bound;
        },
      };
    },
  };
}
