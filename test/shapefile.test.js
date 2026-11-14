import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseShp, parseShx, parseDbf, verifyShx, joinRecords, isNoData,
} from '../src/shapefile.js';
import { buildEncodingPlan, makeFieldDecoder, normalizeCpgLabel } from '../src/encoding.js';

const plots2 = {
  shp: await readFile('fixtures/plots2.shp'),
  shx: await readFile('fixtures/plots2.shx'),
  dbf: await readFile('fixtures/plots2.dbf'),
  prj: await readFile('fixtures/plots2.prj'),
};

test('SHP：PolygonZ 多部件、孔洞、Null Shape 与 Z/M 无数据全部显式保留', () => {
  const shp = parseShp(plots2.shp);
  assert.equal(shp.recordCount, 3);
  assert.equal(shp.header.shapeType, 15);

  const r1 = shp.records[0];
  assert.equal(r1.recordNumber, 1);
  assert.equal(r1.shape.shells.length, 2);
  assert.deepEqual(r1.shape.shells[0].holeRingIndexes, [1]);
  assert.equal(r1.shape.rings[0].role, 'outer');
  assert.equal(r1.shape.rings[1].role, 'hole');
  assert.equal(r1.shape.rings[1].outerRingIndex, 0);
  assert.equal(r1.shape.rings[0].orientation, 'cw');
  assert.equal(r1.shape.rings[1].orientation, 'ccw');
  // Z/M 不静默丢弃：无数据点给出 null 与索引，原始哨兵由阈值识别。
  assert.ok(isNoData(-1e38));
  assert.deepEqual(r1.shape.noDataM, [5, 6, 7, 8, 9]);
  assert.equal(r1.shape.points[5].m, null);
  assert.equal(r1.shape.points[0].m, 1);
  assert.equal(r1.shape.points[0].z, 10);
  assert.equal(r1.shape.mRange.declaredMin > r1.shape.mRange.declaredMax, true);

  const r2 = shp.records[1];
  assert.equal(r2.recordNumber, 2);
  assert.equal(r2.shape.null, true);
  assert.equal(r2.shape.shapeType, 0);

  const r3 = shp.records[2];
  assert.deepEqual(r3.shape.noDataZ, [0]);
  assert.equal(r3.shape.points[0].z, null);
  assert.equal(r3.shape.points[1].z, 30);
  assert.deepEqual(r3.shape.points.map((p) => p.m), [100, 101, 102, 103]);
});

test('SHP：每条记录带原始字节偏移，可切回记录头', () => {
  const shp = parseShp(plots2.shp);
  const r1 = shp.records[0];
  assert.equal(r1.byteOffset, 100);
  assert.equal(plots2.shp.readInt32BE(r1.byteOffset), 1);
  const r2 = shp.records[1];
  assert.equal(plots2.shp.readInt32BE(r2.byteOffset), 2);
  assert.equal(r2.byteLength, 12);
});

test('SHX：完整索引与 SHP 逐条核对通过', () => {
  const shp = parseShp(plots2.shp);
  const shx = parseShx(plots2.shx);
  assert.equal(shx.entryCount, 3);
  assert.deepEqual(verifyShx(shp, shx), []);
});

test('SHX：损坏偏移被识别，不靠行号糊过去', () => {
  const corrupted = Buffer.from(plots2.shx);
  corrupted.writeInt32BE(999, 100);
  const shp = parseShp(plots2.shp);
  const shx = parseShx(corrupted);
  const findings = verifyShx(shp, shx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'shx-entry-mismatch');
  assert.equal(findings[0].shx.byteOffset, 1998);
  assert.equal(findings[0].shp.byteOffset, 100);
});

test('DBF：删除标记与字段字节位置保留，记录号从 1 开始', () => {
  const plan = buildEncodingPlan({ cpgBytes: Buffer.from('UTF-8'), ldid: plots2.dbf[29] });
  const dbf = parseDbf(plots2.dbf, makeFieldDecoder(plan));
  assert.equal(dbf.header.recordCount, 3);
  assert.deepEqual(dbf.records.map((r) => r.deleted), [false, true, false]);
  assert.equal(dbf.records[1].deleteFlag, '*');
  assert.equal(dbf.records[1].values.OWNER.text, '撤销的中间地块');
  assert.equal(dbf.records[0].values.AREA.text, '82.50');
  assert.equal(typeof dbf.records[0].values.OWNER.byteOffset, 'number');
  assert.equal(dbf.records[0].values.OWNER.byteLength, 48);
});

test('DBF：过滤删除行后按行号连接会错位，按记录号连接则正确', () => {
  const plan = buildEncodingPlan({ cpgBytes: Buffer.from('UTF-8'), ldid: plots2.dbf[29] });
  const shp = parseShp(plots2.shp);
  const dbf = parseDbf(plots2.dbf, makeFieldDecoder(plan));
  const joined = joinRecords(shp, dbf);
  assert.deepEqual(joined.findings, []);
  assert.deepEqual(joined.features.map((f) => f.recordNumber), [1, 2, 3]);
  assert.equal(joined.features[2].attributes.values.OWNER.text, '园区西区地块');
  assert.equal(joined.features[2].nullShape, false);
  // 模拟旧错误做法：过滤删除行后用数组下标连接，3 号几何会错配到 2 号属性。
  const liveOnly = dbf.records.filter((r) => !r.deleted);
  assert.equal(liveOnly[1].values.OWNER.text, '园区西区地块');
  assert.notEqual(liveOnly[1].recordNumber, shp.records[1].recordNumber);
});

test('编码：未声明且含非 ASCII 字节时拒绝解码并保留原始 hex', () => {
  const plan = buildEncodingPlan({ cpgBytes: null, ldid: plots2.dbf[29] });
  assert.equal(plan.declared, false);
  assert.equal(plan.ldidHint, 'cp936'); // LDID 只是提示，不据此猜测
  const decoder = makeFieldDecoder(plan);
  const dbf = parseDbf(plots2.dbf, decoder);
  const value = dbf.records[0].values.OWNER;
  assert.equal(value.text, null);
  assert.equal(value.issue.code, 'encoding-undeclared');
  assert.match(value.rawHex, /^[0-9a-f]+$/);
});

test('编码：未声明但纯 ASCII 字段按 ASCII 保留并标注', () => {
  const plan = buildEncodingPlan({ cpgBytes: null, ldid: 0 });
  const decoder = makeFieldDecoder(plan);
  const dbf = parseDbf(plots2.dbf, decoder);
  const area = dbf.records[0].values.AREA;
  assert.equal(area.text, '82.50');
  assert.equal(area.undeclared, true);
});

test('编码：CPG 声明与实际字节不符时解码失败而不是产出乱码', () => {
  // GBK 编码的“园区”（0xD4B0 0xC7F8），却声明 UTF-8：fatal 解码必须失败。
  const plan = buildEncodingPlan({ cpgBytes: Buffer.from('UTF-8'), ldid: 0 });
  const decoder = makeFieldDecoder(plan);
  const field = { name: 'F', type: 'C', length: 4 };
  const result = decoder(Buffer.from([0xd4, 0xb0, 0xc7, 0xf8]), field, 1);
  assert.equal(result.text, null);
  assert.equal(result.issue.code, 'encoding-decode-failed');
  assert.equal(result.rawHex, 'd4b0c7f8');
});

test('编码：CPG 标签规范化与未知标签处理', () => {
  assert.equal(normalizeCpgLabel('utf8').label, 'utf-8');
  assert.equal(normalizeCpgLabel('GBK').label, 'gbk');
  assert.equal(normalizeCpgLabel('  ANSI ').label, 'cp1252');
  assert.equal(normalizeCpgLabel('x-no-such-codepage').unrecognized, true);
});

test('Point 样例 plots：既有 fixture 的删除行与 Null Shape 仍可解析', async () => {
  const shp = parseShp(await readFile('fixtures/plots.shp'));
  const shx = parseShx(await readFile('fixtures/plots.shx'));
  assert.equal(shp.records[1].shape.null, true);
  assert.deepEqual(verifyShx(shp, shx), []);
  assert.equal(shp.records[0].shape.points[0].x, 1);
});

function makeShp(shapeType, bodies) {
  const records = [];
  let offset = 100;
  bodies.forEach((body, i) => {
    const head = Buffer.alloc(8);
    head.writeInt32BE(i + 1, 0);
    head.writeInt32BE(body.length / 2, 4);
    records.push(head, body);
    offset += body.length + 8;
  });
  const file = Buffer.alloc(offset);
  file.writeInt32BE(9994, 0);
  file.writeInt32BE(offset / 2, 24);
  file.writeInt32LE(1000, 28);
  file.writeInt32LE(shapeType, 32);
  Buffer.concat(records).copy(file, 100);
  return file;
}

test('PolylineM：M 区间与逐点 M 值保留，无 M 段时显式标记缺席', () => {
  // 一条折线两个点，带 M；手工构造 23 号形状内容（头4 + 盒32 + 部件/点数8 + 部件索引4 + 坐标32 + M区间16 + M值16）。
  const body = Buffer.alloc(4 + 32 + 8 + 4 + 32 + 32);
  let p = 0;
  body.writeInt32LE(23, p); p += 4;
  for (const v of [0, 0, 9, 9]) { body.writeDoubleLE(v, p); p += 8; }
  body.writeInt32LE(1, p); p += 4;
  body.writeInt32LE(2, p); p += 4;
  body.writeInt32LE(0, p); p += 4;
  body.writeDoubleLE(0, p); body.writeDoubleLE(0, p + 8); p += 16;
  body.writeDoubleLE(9, p); body.writeDoubleLE(9, p + 8); p += 16;
  body.writeDoubleLE(0, p); body.writeDoubleLE(1, p + 8); p += 16;
  body.writeDoubleLE(7, p); body.writeDoubleLE(9, p + 8); p += 16;
  const shp = parseShp(makeShp(23, [body]));
  const shape = shp.records[0].shape;
  assert.equal(shape.typeName, 'PolylineM');
  assert.deepEqual(shape.points.map((q) => q.m), [7, 9]);
  assert.equal(shape.mRange.present, true);
  assert.equal(shape.points[0].z, undefined);

  // 没有 M 段的同型内容：标记 present=false 而不是伪造数值。
  const noM = Buffer.from(body).subarray(0, body.length - 32);
  const shp2 = parseShp(makeShp(23, [noM]));
  assert.equal(shp2.records[0].shape.mRange.present, false);
  assert.deepEqual(shp2.records[0].shape.points.map((q) => q.m), [null, null]);
});

test('Polygon：方向与 ESRI 约定相反时按空间包含归类并给出警告级问题', () => {
  // 外环逆时针、孔洞顺时针（与约定相反），包含关系仍应正确识别。
  const rings = [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]],
  ];
  const points = rings.flat();
  const body = Buffer.alloc(4 + 32 + 8 + 4 * 2 + points.length * 16);
  let p = 0;
  body.writeInt32LE(5, p); p += 4;
  for (const v of [0, 0, 10, 10]) { body.writeDoubleLE(v, p); p += 8; }
  body.writeInt32LE(2, p); p += 4;
  body.writeInt32LE(points.length, p); p += 4;
  body.writeInt32LE(0, p); body.writeInt32LE(5, p + 4); p += 8;
  for (const [x, y] of points) { body.writeDoubleLE(x, p); body.writeDoubleLE(y, p + 8); p += 16; }
  const shp = parseShp(makeShp(5, [body]));
  const shape = shp.records[0].shape;
  assert.equal(shape.rings[0].role, 'outer');
  assert.equal(shape.rings[0].orientationMismatch, true);
  assert.equal(shape.rings[1].role, 'hole');
  assert.deepEqual(shape.shells[0].holeRingIndexes, [1]);
});

test('损坏与不匹配：截断 SHP、SHP/SHX 计数不一致、SHP/DBF 记录数不一致均被报告', () => {
  const shp = parseShp(makeShp(1, [Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]));
  assert.equal(shp.records[0].shape.points[0].x, 0);

  const truncated = Buffer.from(makeShp(1, [Buffer.alloc(20)])).subarray(0, 108);
  const parsedTruncated = parseShp(truncated);
  assert.ok(parsedTruncated.issues.some((i) => i.code === 'shp-record-truncated' || i.code === 'shp-length-mismatch'));

  const shx = parseShx(Buffer.from(readFileSyncShxHeader(1)));
  const countMismatch = verifyShx(
    { records: [{ recordNumber: 1, byteOffset: 100, contentLengthWords: 10 },
      { recordNumber: 2, byteOffset: 128, contentLengthWords: 10 }] }, shx);
  assert.ok(countMismatch.some((f) => f.code === 'shx-count-mismatch'));

  const joined = joinRecords(
    { records: [{ recordNumber: 1 }, { recordNumber: 2 }] },
    { records: [{ recordNumber: 1 }] },
  );
  assert.ok(joined.findings.some((f) => f.code === 'record-count-mismatch'));
  assert.ok(joined.findings.some((f) => f.code === 'join-dbf-missing' && f.recordNumber === 2));
});

function readFileSyncShxHeader(entries) {
  const buf = Buffer.alloc(100 + entries * 8);
  buf.writeInt32BE(9994, 0);
  buf.writeInt32BE(buf.length / 2, 24);
  buf.writeInt32LE(1000, 28);
  return buf;
}

test('未知形状类型与 MultiPatch 不被静默当作普通形状', () => {
  const unknownBody = Buffer.alloc(4); unknownBody.writeInt32LE(999, 0);
  const patchBody = Buffer.alloc(4); patchBody.writeInt32LE(31, 0);
  const shp = parseShp(makeShp(999, [unknownBody, patchBody]));
  assert.equal(shp.records[0].shape.unsupported, true);
  assert.ok(shp.records[0].issues.some((i) => i.code === 'shape-type-unknown'));
  assert.equal(shp.records[1].shape.typeName, 'MultiPatch');
  assert.ok(shp.records[1].issues.some((i) => i.code === 'shape-type-unsupported'));
});

test('DBF：文件过短与截断给出明确错误而不是错位读取', () => {
  assert.throws(() => parseDbf(Buffer.alloc(10)), /短于 32 字节/);
  const dbf = Buffer.from(plots2.dbf);
  const cut = dbf.subarray(0, dbf.length - 40);
  const parsed = parseDbf(cut, (raw) => ({ text: raw.toString('latin1') }));
  assert.ok(parsed.issues.some((i) => i.code === 'dbf-truncated'));
});

test('畸形几何：声明点数超出记录边界时记录为不可读并阻断，而不是崩溃', () => {
  // Polygon(5) 头声明 100 个点，但记录体只给 1 个点的空间。
  const body = Buffer.alloc(4 + 32 + 8 + 4);
  body.writeInt32LE(5, 0);
  body.writeInt32LE(100, 40); // numPoints
  const shp = parseShp(makeShp(5, [body]));
  assert.equal(shp.records[0].shape.unreadable, true);
  assert.ok(shp.issues.some((i) => i.code === 'shp-record-unreadable'));
  assert.equal(shp.records[0].issues[0].code, 'shp-record-unreadable');
});

test('DBF：字段累计长度超过记录长度时报告结构问题', () => {
  const headerLength = 32 + 32 + 1;
  const recordLength = 5; // 删除标记1 + 字段长度10，超界
  const buf = Buffer.alloc(headerLength + recordLength + 1, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt16LE(headerLength, 8);
  buf.writeUInt16LE(recordLength, 10);
  buf.write('BIG', 32, 'ascii'); buf[43] = 67; buf[48] = 10; buf[63] = 13;
  buf[headerLength - 1] = 13;
  const parsed = parseDbf(buf, (raw) => ({ text: raw.toString('latin1') }));
  assert.ok(parsed.issues.some((i) => i.code === 'dbf-field-span-exceeds-record'));
});
