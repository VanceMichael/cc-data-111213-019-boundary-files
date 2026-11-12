import { readFile, readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
export const sample = 'fixtures/plots.shp';
export async function inspect(filename) {
  const bytes = await readFile(filename);
  if (bytes.length < 100 || bytes.readInt32BE(0) !== 9994 || bytes.readInt32LE(28) !== 1000) {
    throw new Error('SHP 文件头无效');
  }
  const declaredLength = bytes.readInt32BE(24) * 2;
  if (declaredLength !== bytes.length) throw new Error('SHP 声明长度不符');
  const stem = basename(filename, '.shp');
  return { length: bytes.length, shapeType: bytes.readInt32LE(32),
    extent: [36,44,52,60].map(offset => bytes.readDoubleLE(offset)),
    files: (await readdir(dirname(filename))).filter(name => name.startsWith(`${stem}.`)).sort() };
}
