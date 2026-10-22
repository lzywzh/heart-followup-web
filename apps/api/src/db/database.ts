import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
// A birth date is a calendar date, not an instant in the server's timezone.
pg.types.setTypeParser(1082, value => value);

export interface Database {
  query<T extends QueryResultRow = any>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(work: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  orm: NodePgDatabase<typeof schema>;
}

export function createDatabase(url: string, namespace = 'public'): Database {
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) throw new Error('Invalid database schema');
  const pool = new pg.Pool({ connectionString: url, max: 8, options: `-c search_path=${namespace},public -c timezone=UTC`, connectionTimeoutMillis: 10000 });
  function wrap(client: pg.Pool | PoolClient): Database {
    return {
      query: (sql, values) => client.query(sql, values),
      orm: drizzle(client, { schema }),
      close: async () => { if (client === pool) await pool.end(); },
      transaction: async work => {
        if (client !== pool) return work(wrap(client));
        const connection = await pool.connect();
        try { await connection.query('BEGIN'); const result = await work(wrap(connection)); await connection.query('COMMIT'); return result; }
        catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
      },
    };
  }
  return wrap(pool);
}
