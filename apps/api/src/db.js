import pg from "pg";
import { config } from "./config.js";

const url = config.databaseUrl;
const needsSsl = config.databaseSsl != null
  ? config.databaseSsl === "true" || config.databaseSsl === "1"
  : !/localhost|127\.0\.0\.1|\.internal/.test(url);

export const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on("error", (err) => console.error("[db] idle client error", err.message));

export const query = (text, params = []) => pool.query(text, params);
export const rows = async (text, params) => (await pool.query(text, params)).rows;
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: (t, p = []) => client.query(t, p),
      rows: async (t, p) => (await client.query(t, p)).rows,
      one: async (t, p) => (await client.query(t, p)).rows[0] ?? null,
    });
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
