// @databases/sqlite (4.0.2) declares `"types": "./lib/index.d.ts"` in
// package.json but ships NO declaration file — a known upstream
// packaging bug. The runtime default export is a callable
// `connect(path)` that returns a connection with a `query()` method.
//
// This shim provides the minimal surface the package actually uses:
// a callable default + a `sql` tagged-template helper. The connection
// returned by `connect()` exposes `query(sql)` returning rows as an
// `unknown[]`; each call site casts the result to its expected row
// shape (same pattern as a SQL driver in any other TS package).
declare module "@databases/sqlite" {
  interface SqlQuery {
    readonly __sqlQuery: true;
  }

  interface DatabaseConnection {
    query(query: SqlQuery): Promise<unknown[]>;
    dispose(): Promise<void>;
  }

  const connect: (filename: string) => DatabaseConnection;
  export default connect;

  // Tagged-template helper. Accepts arbitrary interpolations.
  export const sql: (strings: TemplateStringsArray, ...values: unknown[]) => SqlQuery;
}
