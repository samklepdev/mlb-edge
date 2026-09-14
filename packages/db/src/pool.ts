import pg from 'pg';
import { config } from './config.js';

/**
 * Represents a connection pool for PostgreSQL database operations.
 *
 * The pool manages multiple database connections, allowing for efficient
 * execution of queries by reusing existing connections rather than
 * creating new connections for each query.
 *
 * The connection pool is configured using the connection string provided
 * in the `config.databaseUrl`. This allows the pool to connect to the
 * specified PostgreSQL database instance.
 */
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/**
 * Executes a SQL query on the database using the provided query text and parameters.
 *
 * @param {string} text - The SQL query to execute.
 * @param {unknown[]} [params=[]] - The parameters to pass to the query.
 * @return {Promise<pg.QueryResult<T>>} A promise that resolves to the result of the query.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

/**
 * Executes a function within a database transaction.
 *
 * The transaction is automatically committed if the function succeeds or rolled back if it throws an error.
 *
 * @param {function(pg.PoolClient): Promise<T>} fn - A function that takes a database client
 * and performs operations within the transaction. It should return a promise.
 * @return {Promise<T>} A promise that resolves to the result of the provided function `fn`
 * if the transaction is successfully committed, or rejects if an error occurs.
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
