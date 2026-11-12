import { mkdir as ensureFixtureDirectory } from 'node:fs/promises';
await ensureFixtureDirectory('fixtures', {recursive:true});

import { writeFile } from 'node:fs/promises';
function header(size) {
  const bytes = Buffer.alloc(100); bytes.writeInt32BE(9994, 0); bytes.writeInt32BE(size / 2, 24);
  bytes.writeInt32LE(1000, 28); bytes.writeInt32LE(1, 32);
  [1,2,3,4].forEach((value, index) => bytes.writeDoubleLE(value, 36 + index * 8)); return bytes;
}
const records = [], entries = []; let offset = 100;
for (const [index, point] of [[1,2], null, [3,4]].entries()) {
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
  dbf.write(['园区甲','已删除','园区丙'][index], start + 1, 12, 'utf8');
}
dbf[dbf.length - 1] = 26;
await writeFile('fixtures/plots.dbf', dbf); await writeFile('fixtures/plots.cpg', 'UTF-8');
await writeFile('fixtures/plots.prj', 'LOCAL_CS["园区本地坐标",UNIT["metre",1]]');
