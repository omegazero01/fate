import { expect, it } from 'vitest';
import { AssetQueryError, compileAssetDSL } from './asset-dsl.js';

it('compiles the Planner port/type query with bound values', () => {
  const values: unknown[] = [42];
  expect(compileAssetDSL('port==5200 AND type==endpoint', values))
    .toBe('(a.port = $2) AND (a.type = $3)');
  expect(values).toEqual([42, 5200, 'endpoint']);
});

it('supports type filters in nested queries without interpolating values', () => {
  const values: unknown[] = [];
  const sql = compileAssetDSL('(type==endpoint OR type==service) AND type!=app', values);
  expect(sql).toContain('OR');
  expect(sql).toContain('a.type NOT ILIKE $3');
  expect(values).toEqual(['endpoint', 'service', '%app%']);
  const unsafeValues: unknown[] = [];
  expect(compileAssetDSL('type=="endpoint\' OR TRUE --"', unsafeValues)).toBe('a.type = $1');
  expect(unsafeValues).toEqual(["endpoint' OR TRUE --"]);
});

it.each(['unknown', 'constructor', '__proto__', 'toString'])('rejects unsupported field %s before SQL execution', field => {
  expect(() => compileAssetDSL(`${field}==endpoint`, [])).toThrow(AssetQueryError);
  expect(() => compileAssetDSL(`${field}==endpoint`, [])).toThrow('未知 DSL 字段');
});

it('retains string operator validation for type', () => {
  expect(() => compileAssetDSL('type>=endpoint', [])).toThrow('字符串字段 type 不支持 >=');
});
