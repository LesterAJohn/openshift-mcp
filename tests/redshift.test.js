import assert from "node:assert/strict";
import test from "node:test";

import { RedshiftService } from "../src/services/redshift.js";

test("RedshiftService maps connection options and closes its pool", async () => {
  let poolConfig;
  let ended = false;
  const service = new RedshiftService({
    poolFactory(config) {
      poolConfig = config;
      return {
        async query(sql) {
          assert.match(sql, /current_database/);
          return { rows: [{ database: "warehouse", username: "analyst" }] };
        },
        async end() {
          ended = true;
        }
      };
    }
  });

  const result = await service.healthCheck({
    host: "analytics.example.com",
    port: 5439,
    database: "warehouse",
    username: "analyst",
    password: "secret",
    ssl: true,
    timeoutMs: 5000
  });

  assert.deepEqual(result, { database: "warehouse", username: "analyst" });
  assert.equal(poolConfig.host, "analytics.example.com");
  assert.equal(poolConfig.user, "analyst");
  assert.equal(poolConfig.connectionTimeoutMillis, 5000);
  assert.equal(ended, true);
});

test("RedshiftService returns bounded query results", async () => {
  const service = new RedshiftService({
    poolFactory() {
      return {
        async query(query) {
          assert.deepEqual(query.values, ["active"]);
          return {
            command: "SELECT",
            rowCount: 3,
            fields: [{ name: "id" }],
            rows: [{ id: 1 }, { id: 2 }, { id: 3 }]
          };
        },
        async end() {}
      };
    }
  });

  const result = await service.query(
    { host: "analytics.example.com", database: "warehouse", username: "analyst", password: "secret" },
    "SELECT id FROM events WHERE status = $1",
    ["active"],
    2
  );

  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(result.truncated, true);
});