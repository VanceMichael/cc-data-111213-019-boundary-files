// 成套采集端到端演示：分批到齐、删除行、Null Shape、损坏索引、迟到 CPG、版本不互相覆盖、字节溯源。
// 全部在临时目录内使用合成数据，退出时清理。
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntakeStore } from './intake.js';
import { parseShp, parseShx, verifyShx } from './shapefile.js';

const lines = [];
const say = (text) => { lines.push(text); console.log(text); };
const section = (title) => say(`\n=== ${title} ===`);

async function run() {
  const temporary = await mkdtemp(join(tmpdir(), 'boundary-intake-'));
  const incomingA = join(temporary, 'delivery-A');
  const incomingB = join(temporary, 'delivery-B');
  await mkdir(incomingA, { recursive: true });
  await mkdir(incomingB, { recursive: true });
  try {
    const store = new IntakeStore(join(temporary, 'archive'));

    section('1) 首批交付 plots2：SHP/SHX/DBF/PRJ 先到，CPG 迟到（分批暂存）');
    for (const role of ['shp', 'shx', 'dbf', 'prj']) {
      const bytes = await readFile(`fixtures/plots2.${role}`);
      const result = await store.stage('2026-10', role, bytes, `plots2.${role}`);
      say(`暂存 ${role.toUpperCase()}：对象 ${result.sha256.slice(0, 12)}…（${result.size} 字节）`);
    }
    const incomplete = await store.validate('2026-10');
    say(`校验状态：${incomplete.status}；缺失角色：${incomplete.missingRoles.join(', ').toUpperCase()}`);
    const undeclaredError = incomplete.findings.find((f) => f.code === 'encoding-undeclared' && f.severity === 'error');
    say(`未声明编码且含中文（非 ASCII）→ 阻断：${undeclaredError ? undeclaredError.message : '（未触发）'}`);
    try { await store.publish('2026-10'); say('意外：不完整交付被发布'); }
    catch (error) { say(`发布被拒绝：${error.message}`); }

    section('2) 迟到的编码文件 CPG 补齐');
    await store.stage('2026-10', 'cpg', Buffer.from('UTF-8'), 'plots2.cpg');
    const ready = await store.validate('2026-10');
    say(`补齐后校验状态：${ready.status}；统计：几何 ${ready.stats.shpRecords} 条 / 属性 ${ready.stats.dbfRecords} 条，删除 ${ready.stats.deletedCount} 条，Null Shape ${ready.stats.nullShapeCount} 个`);
    for (const f of ready.findings.filter((x) => x.severity === 'info')) say(`  · [${f.code}] ${f.message}`);

    section('3) 发布 2026-10 并检查对应关系（记录号连接，删除行不导致错位）');
    const published = await store.publish('2026-10');
    for (const feature of published.features) {
      const owner = feature.attributes?.values.OWNER.text ?? null;
      say(`记录 ${feature.recordNumber}：删除=${feature.deleted}，Null=${feature.nullShape}，单位名称="${owner}"，形状=${feature.shape?.shape.typeName}`);
    }
    const shells = published.features[0].shape.shape.shells;
    say(`记录1 多部件：${shells.length} 个外壳；外壳0 含孔洞环 ${JSON.stringify(shells[0].holeRingIndexes)}，外壳1 独立`);
    say(`记录1 Z 无数据点索引：${JSON.stringify(published.features[0].shape.shape.noDataZ)}，M 无数据点索引：${JSON.stringify(published.features[0].shape.shape.noDataM)}`);
    say(`记录3 Z 无数据点索引：${JSON.stringify(published.features[2].shape.shape.noDataZ)}（原始哨兵值保留在几何中）`);
    say(`坐标参考：${published.crs.state}（PRJ 关键字 ${published.crs.keyword}），坐标原样保留`);

    section('4) 字节级溯源：记录1 可查回来源对象与字节偏移');
    const provenance = await store.trace('2026-10', 1);
    for (const source of provenance.sources) {
      say(`来源 ${source.role.toUpperCase()}：对象 ${source.objectSha256.slice(0, 12)}…`);
      if (source.role === 'shp') say(`  记录头偏移 ${source.recordHeader.byteOffset}，几何内容偏移 ${source.geometryContent.byteOffset}`);
      else say(`  记录偏移 ${source.record.byteOffset}，删除标记=${source.record.deleted}`);
    }
    const cut = await store.readSourceBytes('2026-10', 'shp',
      provenance.sources[0].recordHeader.byteOffset, provenance.sources[0].recordHeader.byteLength);
    const headerHex = cut.bytes.subarray(0, 8).toString('hex');
    say(`切回的 SHP 记录头十六进制：${headerHex}（前四字节为记录号 00000001），片段摘要 ${cut.sha256.slice(0, 12)}…`);

    section('5) 损坏的 SHX 索引：按索引/行号重连会被拦下');
    const goodShx = await readFile('fixtures/plots2.shx');
    const corrupted = Buffer.from(goodShx);
    corrupted.writeInt32BE(999, 100); // 篡改第一条索引的偏移
    await writeFile(join(incomingA, 'plots2.shx'), corrupted);
    const shxParsed = parseShx(corrupted);
    const shpParsed = parseShp(await readFile('fixtures/plots2.shp'));
    const mismatches = verifyShx(shpParsed, shxParsed);
    say(`verifyShx 报告 ${mismatches.length} 处不一致，首处：${JSON.stringify(mismatches[0])}`);
    await store.stage('2026-11', 'shp', await readFile('fixtures/plots2.shp'), 'plots2.shp');
    await store.stage('2026-11', 'shx', corrupted, 'plots2.shx');
    await store.stage('2026-11', 'dbf', await readFile('fixtures/plots2.dbf'), 'plots2.dbf');
    await store.stage('2026-11', 'prj', await readFile('fixtures/plots2.prj'), 'plots2.prj');
    await store.stage('2026-11', 'cpg', Buffer.from('UTF-8'), 'plots2.cpg');
    const blocked = await store.validate('2026-11');
    say(`损坏索引交付校验状态：${blocked.status}`);
    for (const f of blocked.findings.filter((item) => item.code.startsWith('shx'))) say(`  · [${f.severity}/${f.code}] ${f.message}`);
    try { await store.publish('2026-11'); say('意外：损坏索引交付被发布'); }
    catch (error) { say(`发布被拒绝：${error.message}`); }


    section('6) 新交付不完整时，已发布的上一套仍然存在');
    const current = await store.current();
    say(`当前指针仍指向：${current.pointer.deliveryId}（发布于 ${current.pointer.publishedAt}）`);
    const releases = await store.releases();
    say(`releases 目录中的不可变快照：${releases.map((r) => r.deliveryId).join(', ')}`);

    section('7) 坐标参考缺失：保留原坐标与 unknown，不默认经纬度');
    await store.stage('2026-12', 'shp', await readFile('fixtures/plots.shp'), 'plots.shp');
    await store.stage('2026-12', 'shx', await readFile('fixtures/plots.shx'), 'plots.shx');
    await store.stage('2026-12', 'dbf', await readFile('fixtures/plots.dbf'), 'plots.dbf');
    await store.stage('2026-12', 'cpg', await readFile('fixtures/plots.cpg'), 'plots.cpg');
    const noPrj = await store.validate('2026-12');
    say(`缺 PRJ 校验状态：${noPrj.status}（warning 不阻断）；CRS=${noPrj.crs.state}`);
    const localRelease = await store.publish('2026-12');
    const pointFeature = localRelease.features.find((f) => f.recordNumber === 1);
    say(`坐标按原值保留：x=${pointFeature.shape.shape.points[0].x}, y=${pointFeature.shape.shape.points[0].y}，未做经纬度假定`);
    const current2 = await store.current();
    say(`指针切换为 ${current2.pointer.deliveryId}，但 2026-10 快照仍可读取：${(await store.getRelease('2026-10')).deliveryId}`);

    section('演示完成');
    return { temporary, output: lines.join('\n') };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runIntakeDemo() {
  await run();
}
