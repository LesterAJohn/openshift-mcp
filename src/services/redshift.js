import pg from "pg";

const { Pool } = pg;

export class RedshiftService {
  constructor({ poolFactory = (config) => new Pool(config) } = {}) {
    this.poolFactory = poolFactory;
  }

  createPool({ host, port = 5439, database, username, password, ssl = true, timeoutMs = 15000 }) {
    return this.poolFactory({
      host,
      port,
      database,
      user: username,
      password,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      max: 1
    });
  }

  async withPool(connection, operation) {
    const pool = this.createPool(connection);
    try {
      return await operation(pool);
    } finally {
      await pool.end();
    }
  }

  async healthCheck(connection) {
    return this.withPool(connection, async (pool) => {
      const result = await pool.query("SELECT current_database() AS database, current_user AS username");
      return result.rows[0];
    });
  }

  async query(connection, sql, parameters = [], maxRows = 1000) {
    return this.withPool(connection, async (pool) => {
      const result = await pool.query({ text: sql, values: parameters, rowMode: "object" });
      const rows = result.rows.slice(0, maxRows);
      return {
        command: result.command,
        rowCount: result.rowCount,
        fields: result.fields.map((field) => field.name),
        rows,
        truncated: result.rows.length > rows.length
      };
    });
  }
}