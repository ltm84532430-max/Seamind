import { describe, expect, it } from 'vitest';
import {
  buildFederatedJoinSql,
  buildTablePythonSnippet,
  buildTableRSnippet,
  buildTableSelectSql,
  diagnoseDatabaseError,
  formatEstimatedRows,
  groupTablesBySchema,
  parseDatabaseUrl,
} from '../src/terminal/db-connection-utils';
import type { DataDbTableSchema } from '../src/terminal/terminal-api';
import type { DataLabDbConnection } from '../src/terminal/terminal-codelab-model';

describe('db-connection-utils', () => {
  it('parses PostgreSQL, MySQL, SQLite, and DuckDB connection URLs', () => {
    const pg = parseDatabaseUrl(
      'postgresql://postgres:p%40ss%3A123@127.0.0.1:5432/FED?sslmode=require',
    );
    expect(pg).toMatchObject({
      dbType: 'postgres',
      host: '127.0.0.1',
      port: '5432',
      database: 'FED',
      username: 'postgres',
      password: 'p@ss:123',
      sslMode: 'require',
    });

    const mysql = parseDatabaseUrl('mysql://root:sec@10.0.0.2/macro');
    expect(mysql).toMatchObject({
      dbType: 'mysql',
      host: '10.0.0.2',
      port: '3306',
      database: 'macro',
      username: 'root',
      password: 'sec',
    });

    const sqlite = parseDatabaseUrl('sqlite:///C:/data/macro.db');
    expect(sqlite).toMatchObject({
      dbType: 'sqlite',
      filePath: 'C:/data/macro.db',
    });

    const duck = parseDatabaseUrl('duckdb:///C:/data/quant.duckdb');
    expect(duck).toMatchObject({
      dbType: 'duckdb',
      filePath: 'C:/data/quant.duckdb',
    });

    expect(parseDatabaseUrl('not-a-valid-dsn')).toBeNull();
  });

  it('produces actionable Chinese diagnostics for common PostgreSQL errors', () => {
    const auth = diagnoseDatabaseError(
      'connection failed: FATAL: password authentication failed for user "postgres"',
      'postgres',
    );
    expect(auth.title).toContain('密码');
    expect(auth.suggestions.some((s) => s.includes('pgpass.conf'))).toBe(true);

    const missingDb = diagnoseDatabaseError(
      'FATAL: database "fed" does not exist',
      'postgres',
    );
    expect(missingDb.title).toContain('不存在');
    expect(missingDb.suggestions.some((s) => s.includes('区分大小写'))).toBe(
      true,
    );

    const ro = diagnoseDatabaseError(
      'ERROR: cannot execute DELETE in a read-only transaction',
      'postgres',
    );
    expect(ro.title).toContain('只读');
  });

  it('groups multi-schema tables, prioritizes non-public schemas, and sorts by estimated row count', () => {
    const tables: DataDbTableSchema[] = [
      {
        name: 'audit_log',
        schema: 'public',
        tableType: 'table',
        estimatedRows: 50,
        columns: [{ name: 'id', dataType: 'bigint' }],
      },
      {
        name: 'series',
        schema: 'fred',
        tableType: 'table',
        estimatedRows: 1200,
        columns: [{ name: 'series_id', dataType: 'text' }],
      },
      {
        name: 'observations',
        schema: 'fred',
        tableType: 'table',
        estimatedRows: 1_030_485,
        columns: [
          { name: 'series_id', dataType: 'text', isPrimaryKey: true },
          { name: 'value', dataType: 'numeric(20,6)' },
        ],
      },
    ];

    const grouped = groupTablesBySchema(tables, '');
    expect(grouped.map((g) => g.schema)).toEqual(['fred', 'public']);
    expect(grouped[0].tables.map((t) => t.name)).toEqual([
      'observations',
      'series',
    ]);

    const byColumn = groupTablesBySchema(tables, 'value');
    expect(byColumn).toHaveLength(1);
    expect(byColumn[0].tables.map((t) => t.name)).toEqual(['observations']);
    expect(formatEstimatedRows(1_030_485)).toBe('~1.03M 行');
  });

  it('generates password-free SQL, Python, R, and DuckDB federated snippets', () => {
    const conn: DataLabDbConnection = {
      id: 'db-fed',
      name: 'FED 宏观库',
      dbType: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'FED',
      username: 'postgres',
      readOnly: true,
    };

    const sql = buildTableSelectSql('observations', 'fred', 'postgres', 100);
    expect(sql).toContain('"fred"."observations"');
    expect(sql).toContain('LIMIT 100;');

    const py = buildTablePythonSnippet(conn, 'observations', 'fred', 5000);
    expect(py).toContain('sm_db_query(');
    expect(py).toContain('"FED 宏观库"');
    expect(py).not.toContain('password');

    const r = buildTableRSnippet(conn, 'observations', 'fred', 5000);
    expect(r).toContain('sm_db_query(');
    expect(r).not.toContain('password');

    const fed = buildFederatedJoinSql(
      conn,
      'observations',
      'fred',
      't_2022_12_19',
    );
    expect(fed).toContain('"fed"."fred"."observations"');
    expect(fed).toContain('"t_2022_12_19"');
  });
});
