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
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...v: unknown[]) {
          const params = v as never[];
          return {
            async first<T>() {
              return ((stmt.get(...params) as T | undefined) ?? null);
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[] };
            },
            async run() {
              const r = stmt.run(...params);
              return { meta: { changes: Number(r.changes) } };
            },
          };
        },
      };
    },
  };
}
