import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, sample } from '../src/domain.js';

test('既有资料查看与本地来源符合领域约定', async () => {
  const result = await inspect(sample);
  assert.equal(result.shapeType, 1);
  assert.ok(result.files.includes('plots.dbf'));
  const dbf = await readFile('fixtures/plots.dbf');
  assert.equal(dbf[78], 42);
  const shapes = await readFile(sample);
  assert.equal(shapes.readInt32LE(136), 0);
});
