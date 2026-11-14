import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntakeStore } from '../src/intake.js';

async function loadPlots2() {
  const bytes = {};
  for (const role of ['shp', 'shx', 'dbf', 'prj']) {
    bytes[role] = await readFile(`fixtures/plots2.${role}`);
  }
  return bytes;
}

async function withStore(callback) {
  const folder = await mkdtemp(join(tmpdir(), 'intake-test-'));
  try { await callback(new IntakeStore(folder), folder); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

test('分批到齐：CPG 迟到前阻断发布，补齐后整套通过', async () => {
  await withStore(async (store) => {
    const bytes = await loadPlots2();
    for (const role of ['shp', 'shx', 'dbf', 'prj']) await store.stage('d1', role, bytes[role]);
    const before = await store.validate('d1');
    assert.equal(before.status, 'blocked');
    assert.deepEqual(before.missingRoles, ['cpg']);
    assert.ok(before.findings.some((f) => f.code === 'encoding-undeclared' && f.severity === 'error'));
    await assert.rejects(store.publish('d1'), /拒绝发布/);

    await store.stage('d1', 'cpg', Buffer.from('UTF-8'));
    const after = await store.validate('d1');
    assert.equal(after.status, 'ready');
    assert.equal(after.encoding.label, 'utf-8');
    const manifest = await store.publish('d1');
    assert.equal(manifest.deliveryId, 'd1');
    assert.equal(manifest.features.length, 3);
  });
});

test('删除行与 Null Shape 按记录号对应，后续单位名称不发生错位', async () => {
  await withStore(async (store) => {
    const bytes = await loadPlots2();
    for (const role of ['shp', 'shx', 'dbf', 'prj', 'cpg']) {
      await store.stage('d1', role, role === 'cpg' ? Buffer.from('UTF-8') : bytes[role]);
    }
    const manifest = await store.publish('d1');
    const owners = manifest.features.map((f) => f.attributes.values.OWNER.text);
    assert.deepEqual(owners, ['园区东区地块', '撤销的中间地块', '园区西区地块']);
    const second = manifest.features[1];
    assert.equal(second.deleted, true);
    assert.equal(second.nullShape, true);
    assert.equal(second.shape.shape.shapeType, 0);
  });
});

test('损坏的 SHX 阻断发布，且不影响已发布的上一套', async () => {
  await withStore(async (store) => {
    const bytes = await loadPlots2();
    for (const role of ['shp', 'shx', 'dbf', 'prj', 'cpg']) {
      await store.stage('good', role, role === 'cpg' ? Buffer.from('UTF-8') : bytes[role]);
    }
    const first = await store.publish('good');
    const firstPublishedAt = first.publishedAt;

    const corrupted = Buffer.from(bytes.shx);
    corrupted.writeInt32BE(7, 100);
    for (const role of ['shp', 'dbf', 'prj', 'cpg']) {
      await store.stage('bad', role, role === 'cpg' ? Buffer.from('UTF-8') : bytes[role]);
    }
    await store.stage('bad', 'shx', corrupted);
    const report = await store.validate('bad');
    assert.equal(report.status, 'blocked');
    assert.ok(report.findings.some((f) => f.code === 'shx-entry-mismatch'));
    await assert.rejects(store.publish('bad'), /阻断/);

    const current = await store.current();
    assert.equal(current.pointer.deliveryId, 'good');
    assert.equal(current.pointer.publishedAt, firstPublishedAt);
    const releases = await store.releases();
    assert.deepEqual(releases.map((r) => r.deliveryId), ['good']);
  });
});

test('缺 PRJ：坐标原样保留且 CRS 为 unknown，不按经纬度解释', async () => {
  await withStore(async (store) => {
    const shp = await readFile('fixtures/plots.shp');
    const shx = await readFile('fixtures/plots.shx');
    const dbf = await readFile('fixtures/plots.dbf');
    const cpg = await readFile('fixtures/plots.cpg');
    for (const [role, data] of [['shp', shp], ['shx', shx], ['dbf', dbf], ['cpg', cpg]]) {
      await store.stage('local', role, data);
    }
    const report = await store.validate('local');
    assert.equal(report.status, 'ready');
    assert.equal(report.crs.state, 'unknown');
    const manifest = await store.publish('local');
    assert.equal(manifest.features[0].shape.shape.points[0].x, 1);
    assert.equal(manifest.crs.declared, false);
  });
});

test('发布不可变：新版本切换 current 后旧快照仍可读取，溯源字节可查回', async () => {
  await withStore(async (store) => {
    const bytes = await loadPlots2();
    for (const role of ['shp', 'shx', 'dbf', 'prj', 'cpg']) {
      await store.stage('v1', role, role === 'cpg' ? Buffer.from('UTF-8') : bytes[role]);
    }
    await store.publish('v1');
    for (const role of ['shp', 'shx', 'dbf', 'cpg']) {
      await store.stage('v2', role, role === 'cpg' ? Buffer.from('UTF-8') : bytes[role]);
    }
    await store.stage('v2', 'prj', bytes.prj);
    await store.publish('v2');
    assert.equal((await store.current()).pointer.deliveryId, 'v2');
    const old = await store.getRelease('v1');
    assert.equal(old.deliveryId, 'v1');

    const provenance = await store.trace('v1', 1);
    const shpSource = provenance.sources.find((s) => s.role === 'shp');
    const cut = await store.readSourceBytes('v1', 'shp',
      shpSource.recordHeader.byteOffset, shpSource.recordHeader.byteLength);
    assert.equal(cut.bytes.readInt32BE(0), 1);
    assert.equal(cut.objectSha256, old.components.shp.sha256);
    const dbfSource = provenance.sources.find((s) => s.role === 'dbf');
    assert.equal(typeof dbfSource.fields.OWNER.byteOffset, 'number');
  });
});

test('暂存清单记录修订历史：同一角色重复到齐时保留替换链', async () => {
  await withStore(async (store) => {
    const bytes = await loadPlots2();
    const first = await store.stage('d1', 'prj', bytes.prj);
    const revised = Buffer.concat([bytes.prj, Buffer.from('\n')]);
    const second = await store.stage('d1', 'prj', revised);
    assert.equal(second.replaced, first.sha256);
    const manifest = await store.getStaging('d1');
    assert.equal(manifest.revisions.length, 2);
    assert.equal(manifest.components.prj.sha256, second.sha256);
  });
});

test('stageDirectory：按扩展名归位角色，无法识别的文件登记但不参与解析', async () => {
  await withStore(async (store, folder) => {
    const incoming = join(folder, 'incoming');
    await mkdir(incoming, { recursive: true });
    const bytes = await loadPlots2();
    for (const role of ['shp', 'shx', 'dbf', 'prj']) await writeFile(join(incoming, `plots2.${role}`), bytes[role]);
    await writeFile(join(incoming, 'readme.txt'), '说明');
    const result = await store.stageDirectory('d9', incoming);
    assert.deepEqual(result.staged.map((s) => s.role).sort(), ['dbf', 'prj', 'shp', 'shx']);
    assert.equal(result.unknown[0].name, 'readme.txt');
    const report = await store.validate('d9');
    assert.deepEqual(report.missingRoles, ['cpg']);
  });
});

test('交付编号与角色做输入约束', async () => {
  await withStore(async (store) => {
    await assert.rejects(store.stage('../escape', 'shp', Buffer.from('x')), /交付编号/);
    await assert.rejects(store.stage('ok', 'exe', Buffer.from('x')), /未知交付角色/);
  });
});

test('发布快照不可变：同一交付编号第二次发布被拒绝', async () => {
  await withStore(async (store) => {
    const bytes = await loadPlots2();
    for (const role of ['shp', 'shx', 'dbf', 'prj', 'cpg']) {
      await store.stage('once', role, role === 'cpg' ? Buffer.from('UTF-8') : bytes[role]);
    }
    await store.publish('once');
    // 即使暂存内容被修订，已发布编号也不能覆盖。
    await store.stage('once', 'prj', Buffer.concat([bytes.prj, Buffer.from('\n')]));
    await assert.rejects(store.publish('once'), /已发布/);
    const current = await store.current();
    assert.equal(current.pointer.deliveryId, 'once');
  });
});
