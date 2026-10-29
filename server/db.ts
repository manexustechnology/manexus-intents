// D1-compatible subset used by server code, so tests can swap in node:sqlite.
export type Stmt = {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
};
export type Db = {
  prepare(sql: string): { bind(...v: unknown[]): Stmt };
  /** Run bound statements in order as one transaction (D1 `batch`): all apply, or none do. */
  batch(stmts: Stmt[]): Promise<{ meta: { changes: number } }[]>;
};
