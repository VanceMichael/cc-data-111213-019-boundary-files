import { mkdir as ensureFixtureDirectory, writeFile } from 'node:fs/promises';
await ensureFixtureDirectory('fixtures', { recursive: true });

function header(size, shapeType = 1) {
  const bytes = Buffer.alloc(100); bytes.writeInt32BE(9994, 0); bytes.writeInt32BE(size / 2, 24);
  bytes.writeInt32LE(1000, 28); bytes.writeInt32LE(shapeType, 32);
  [1, 2, 3, 4].forEach((value, index) => bytes.writeDoubleLE(value, 36 + index * 8));
  return bytes;
}

// ---- 既有 Point 样例（plots）：含一条删除行与一个 Null Shape ----
const records = [], entries = []; let offset = 100;
for (const [index, point] of [[1, 2], null, [3, 4]].entries()) {
  const body = Buffer.alloc(point ? 20 : 4); body.writeInt32LE(point ? 1 : 0);
  if (point) { body.writeDoubleLE(point[0], 4); body.writeDoubleLE(point[1], 12); }
  const record = Buffer.alloc(8); record.writeInt32BE(index + 1, 0); record.writeInt32BE(body.length / 2, 4);
  records.push(record, body); const entry = Buffer.alloc(8); entry.writeInt32BE(offset / 2); entry.writeInt32BE(body.length / 2, 4);
  entries.push(entry); offset += body.length + 8;
}
await writeFile('fixtures/plots.shp', Buffer.concat([header(offset), ...records]));
await writeFile('fixtures/plots.shx', Buffer.concat([header(124), ...entries]));
const dbf = Buffer.alloc(65 + 3 * 13 + 1, 0); dbf[0] = 3; dbf[1] = 126; dbf[2] = 11; dbf[3] = 1;
dbf.writeUInt32LE(3, 4); dbf.writeUInt16LE(65, 8); dbf.writeUInt16LE(13, 10);
dbf.write('OWNER', 32, 'ascii'); dbf[43] = 67; dbf[48] = 12; dbf[64] = 13;
for (let index = 0; index < 3; index += 1) {
  const start = 65 + index * 13; dbf.fill(32, start, start + 13); dbf[start] = index === 1 ? 42 : 32;
  dbf.write(['园区甲', '已删除', '园区丙'][index], start + 1, 12, 'utf8');
}
dbf[dbf.length - 1] = 26;
await writeFile('fixtures/plots.dbf', dbf); await writeFile('fixtures/plots.cpg', 'UTF-8');
await writeFile('fixtures/plots.prj', 'LOCAL_CS["园区本地坐标",UNIT["metre",1]]');

// ---- PolygonZ 样例（plots2）：多部件、孔洞、Null Shape、删除行、Z/M 无数据哨兵 ----
const NO_DATA = -1e38;

function polygonZRecord(recordNumber, rings, zValues, mValues) {
  const pointCount = rings.reduce((sum, ring) => sum + ring.length, 0);
  const parts = rings.length;
  let contentLength = 4 + 32 + 4 + 4 + parts * 4 + pointCount * 16 + 16 + pointCount * 8 + 16 + pointCount * 8;
  const body = Buffer.alloc(contentLength);
  let p = 0;
  body.writeInt32LE(15, p); p += 4;
  const xs = rings.flat().map((q) => q[0]), ys = rings.flat().map((q) => q[1]);
  for (const v of [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]) { body.writeDoubleLE(v, p); p += 8; }
  body.writeInt32LE(parts, p); p += 4;
  body.writeInt32LE(pointCount, p); p += 4;
  let running = 0;
  for (const ring of rings) { body.writeInt32LE(running, p); p += 4; running += ring.length; }
  for (const [x, y] of rings.flat()) { body.writeDoubleLE(x, p); body.writeDoubleLE(y, p + 8); p += 16; }
  const finiteZ = zValues.filter((v) => v > NO_DATA);
  body.writeDoubleLE(Math.min(...finiteZ), p); body.writeDoubleLE(Math.max(...finiteZ), p + 8); p += 16;
  for (const z of zValues) { body.writeDoubleLE(z, p); p += 8; }
  // 整体 M 区间：含无数据时按 ESRI 约定写反序（min > max 表示无有效范围）。
  const finiteM = mValues.filter((v) => v > NO_DATA);
  if (finiteM.length === mValues.length) { body.writeDoubleLE(Math.min(...finiteM), p); body.writeDoubleLE(Math.max(...finiteM), p + 8); }
  else if (finiteM.length === 0) { body.writeDoubleLE(NO_DATA, p); body.writeDoubleLE(NO_DATA, p + 8); }
  else { body.writeDoubleLE(Math.max(...finiteM), p); body.writeDoubleLE(Math.min(...finiteM), p + 8); }
  p += 16;
  for (const m of mValues) { body.writeDoubleLE(m, p); p += 8; }
  const head = Buffer.alloc(8);
  head.writeInt32BE(recordNumber, 0); head.writeInt32BE(body.length / 2, 4);
  return Buffer.concat([head, body]);
}

// 记录1：一个外壳带孔洞 + 第二个独立外壳（多部件）。外环顺时针、孔洞逆时针（ESRI 约定）。
const record1Rings = [
  [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]],          // 外环（顺时针）
  [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],              // 孔洞（逆时针）
  [[20, 20], [20, 30], [30, 30], [30, 20], [20, 20]],    // 第二个外壳
];
const record1 = polygonZRecord(1, record1Rings,
  [10, 10, 10, 10, 10, 5, 5, 5, 5, 5, 20, 20, 20, 20, 20],
  [1, 2, 3, 4, 5, NO_DATA, NO_DATA, NO_DATA, NO_DATA, NO_DATA, 6, 7, 8, 9, 10]);
// 记录2：Null Shape（4 字节内容，形状类型 0）
const nullBody = Buffer.alloc(4); nullBody.writeInt32LE(0, 0);
const nullHead = Buffer.alloc(8); nullHead.writeInt32BE(2, 0); nullHead.writeInt32BE(2, 4);
const record2 = Buffer.concat([nullHead, nullBody]);
// 记录3：简单三角面，Z 带无数据哨兵，M 正常
const record3 = polygonZRecord(3, [[[40, 40], [45, 50], [50, 40], [40, 40]]],
  [NO_DATA, 30, 30, 30], [100, 101, 102, 103]);

const shp2 = Buffer.concat([header(100 + record1.length + record2.length + record3.length, 15), record1, record2, record3]);
await writeFile('fixtures/plots2.shp', shp2);
// SHX 偏移与内容长度直接按实际记录字节生成，避免手算误差。
const shxRecords = [record1, record2, record3];
const shx2 = Buffer.alloc(100 + shxRecords.length * 8);
shx2.set(header(shx2.length, 15), 0);
let runningOffset = 50;
shxRecords.forEach((chunk, i) => {
  const contentLengthWords = (chunk.length - 8) / 2;
  shx2.writeInt32BE(runningOffset, 100 + i * 8);
  shx2.writeInt32BE(contentLengthWords, 104 + i * 8);
  runningOffset += contentLengthWords + 4;
});
await writeFile('fixtures/plots2.shx', shx2);

// DBF：3 条记录，记录2 删除标记；字段 OWNER(48,C) + AREA(10,N,2)
const fieldCount2 = 2;
const headerLength2 = 32 + fieldCount2 * 32 + 1;
const recordLength2 = 1 + 48 + 10;
const dbf2 = Buffer.alloc(headerLength2 + 3 * recordLength2 + 1, 0);
dbf2[0] = 0x83; dbf2[1] = 126; dbf2[2] = 11; dbf2[3] = 14;
dbf2.writeUInt32LE(3, 4); dbf2.writeUInt16LE(headerLength2, 8); dbf2.writeUInt16LE(recordLength2, 10);
dbf2[29] = 0x4d; // LDID 提示 GBK，但没有 CPG 时不得据此猜测
dbf2.write('OWNER', 32, 'ascii'); dbf2[43] = 67; dbf2[48] = 48; dbf2[63] = 13;
dbf2.write('AREA', 64, 'ascii'); dbf2[75] = 78; dbf2[80] = 10; dbf2[81] = 2; dbf2[95] = 13;
dbf2[headerLength2 - 1] = 13;
const owners = ['园区东区地块', '撤销的中间地块', '园区西区地块'];
for (let i = 0; i < 3; i += 1) {
  const start = headerLength2 + i * recordLength2;
  dbf2[start] = i === 1 ? 42 : 32;
  dbf2.fill(32, start + 1, start + recordLength2);
  dbf2.write(owners[i], start + 1, 48, 'utf8');
  dbf2.write(['82.50', '0.00', '50.00'][i], start + 49, 10, 'ascii');
}
dbf2[dbf2.length - 1] = 26;
await writeFile('fixtures/plots2.dbf', dbf2);
await writeFile('fixtures/plots2.prj', 'PROJCS["园区投影",GEOGCS["GCS",DATUM["D",SPHEROID["S",6378137,298.257]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["false_easting",500000],UNIT["metre",1]]');
// 注意：故意不写 plots2.cpg，用于演示“编码未声明 → 迟到 CPG 补齐后才发布”。
