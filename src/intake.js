// 成套交付的暂存、校验与发布生命周期。
// 分批到齐 → 整套对应关系校验 → 原子发布；已发布版本不可被不完整的新交付覆盖或删除。
import { mkdir, open, readFile, rename, readdir, rm } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Archive, digest } from './archive.js';
import { parseShp, parseShx, parseDbf, verifyShx, joinRecords } from './shapefile.js';
import { buildEncodingPlan, makeFieldDecoder } from './encoding.js';

export const ROLES = ['shp', 'shx', 'dbf', 'prj', 'cpg'];
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function finding(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

export class IntakeStore {
  constructor(directory) {
    this.directory = resolve(directory);
    this.archive = new Archive(directory);
  }

  async #writeAtomic(path, text) {
    await mkdir(join(path, '..'), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }

  #stagingPath(deliveryId) {
    if (!DELIVERY_ID_PATTERN.test(deliveryId)) throw new Error('交付编号只能含字母数字、点、下划线与连字符');
    return join(this.directory, 'staging', deliveryId, 'manifest.json');
  }

  #releasePath(deliveryId) {
    if (!DELIVERY_ID_PATTERN.test(deliveryId)) throw new Error('交付编号只能含字母数字、点、下划线与连字符');
    return join(this.directory, 'releases', deliveryId, 'manifest.json');
  }

  async #loadStaging(deliveryId) {
    try {
      return JSON.parse(await readFile(this.#stagingPath(deliveryId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { deliveryId, createdAt: new Date().toISOString(), components: {}, revisions: [] };
      }
      throw error;
    }
  }

  async #saveStaging(manifest) {
    manifest.updatedAt = new Date().toISOString();
    await this.#writeAtomic(this.#stagingPath(manifest.deliveryId), JSON.stringify(manifest, null, 2));
  }

  async listStaging() {
    const root = join(this.directory, 'staging');
    let names = [];
    try { names = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return Promise.all(names.filter((d) => d.isDirectory()).map((d) => this.#loadStaging(d.name)));
  }

  async getStaging(deliveryId) {
    const manifest = await this.#loadStaging(deliveryId);
    if (!manifest.updatedAt) throw new Error(`暂存交付 ${deliveryId} 不存在`);
    return manifest;
  }

  // role 为 shp/shx/dbf/prj/cpg；bytes 为该文件的原始字节。
  async stage(deliveryId, role, bytes, sourceName = null) {
    const roleKey = role.toLowerCase();
    if (!ROLES.includes(roleKey)) throw new Error(`未知交付角色：${role}`);
    const { sha256, size } = await this.archive.put(bytes);
    const manifest = await this.#loadStaging(deliveryId);
    const previous = manifest.components[roleKey];
    manifest.components[roleKey] = { role: roleKey, sha256, size, sourceName, stagedAt: new Date().toISOString() };
    manifest.revisions.push({ role: roleKey, sha256, size, sourceName, stagedAt: new Date().toISOString(),
      replaced: previous?.sha256 ?? null });
    await this.#saveStaging(manifest);
    return { deliveryId, role: roleKey, sha256, size, replaced: previous?.sha256 ?? null };
  }

  // 从一个目录批量暂存；扩展名决定角色，无法识别的文件只登记不参与解析。
  async stageDirectory(deliveryId, directory) {
    const names = (await readdir(directory, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name).sort();
    const results = [];
    const unknown = [];
    for (const name of names) {
      const ext = extname(name).slice(1).toLowerCase();
      if (ROLES.includes(ext)) {
        const bytes = await readFile(join(directory, name));
        results.push(await this.stage(deliveryId, ext, bytes, name));
      } else {
        const sha = digest(await readFile(join(directory, name)));
        unknown.push({ name, extension: ext, sha256: sha });
      }
    }
    return { deliveryId, staged: results, unknown };
  }

  async #readComponent(manifest, role) {
    const component = manifest.components[role];
    if (!component) return null;
    const bytes = await this.archive.read(component.sha256);
    return { component, bytes };
  }

  #classifyCrs(prjBytes, findings) {
    if (prjBytes == null) {
      findings.push(finding('warning', 'crs-unknown', '缺少 PRJ：坐标参考未知，保留原坐标且不按经纬度解释'));
      return { state: 'unknown', declared: false };
    }
    const wkt = prjBytes.toString('utf8');
    const match = wkt.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[/);
    const keyword = match?.[1]?.toUpperCase();
    const kinds = {
      GEOGCS: 'declared-geographic', PROJCS: 'declared-projected',
      LOCAL_CS: 'declared-local', GEOCCS: 'declared-geocentric',
    };
    if (keyword && kinds[keyword]) {
      return { state: kinds[keyword], declared: true, keyword, wkt };
    }
    findings.push(finding('warning', 'prj-unrecognized', 'PRJ 首关键字无法识别，保留原文与原坐标，不假定经纬度', { keyword: keyword ?? null }));
    return { state: 'declared-other', declared: true, keyword: keyword ?? null, wkt };
  }

  // 整套校验：几何/属性按记录号对应，输出分级问题清单；不修改任何已发布版本。
  async validate(deliveryId) {
    const staging = await this.getStaging(deliveryId);
    const findings = [];
    const present = ROLES.filter((role) => staging.components[role]);
    for (const role of ROLES) {
      if (!staging.components[role]) {
        const severity = role === 'prj' || role === 'cpg' ? 'warning' : 'error';
        findings.push(finding(severity, `${role}-missing`, `缺少 ${role.toUpperCase()} 文件`));
      }
    }
    const read = async (role) => {
      const loaded = await this.#readComponent(staging, role);
      return loaded ? loaded.bytes : null;
    };
    const [shpBytes, shxBytes, dbfBytes, prjBytes, cpgBytes] =
      await Promise.all(ROLES.map((role) => read(role)));

    let shp = null, shx = null, dbf = null;
    let encodingPlan = { declared: false, label: null };
    if (shpBytes) {
      try { shp = parseShp(shpBytes); }
      catch (error) { findings.push(finding('error', 'shp-invalid', error.message)); }
    }
    if (shxBytes) {
      try { shx = parseShx(shxBytes); }
      catch (error) { findings.push(finding('error', 'shx-invalid', error.message)); }
    }
    if (dbfBytes) {
      try {
        const ldid = (() => { try { return dbfBytes[29]; } catch { return 0; } })();
        const plan = buildEncodingPlan({ cpgBytes, ldid });
        if (plan.unrecognized) {
          findings.push(finding('error', 'cpg-unrecognized', `CPG 声明的编码无法识别：${plan.cpgRaw}`, { cpgRaw: plan.cpgRaw }));
        }
        if (!plan.declared) {
          findings.push(finding('warning', 'encoding-undeclared',
            plan.ldidHint ? `缺少 CPG，编码未声明；LDID 仅提示为 ${plan.ldidHint}，不据此猜测` : '缺少 CPG，编码未声明，且 LDID 无提示，不猜测编码',
            { ldid: plan.ldid, ldidHint: plan.ldidHint }));
        }
        const decoder = makeFieldDecoder(plan);
        dbf = parseDbf(dbfBytes, decoder);
        for (const record of dbf.records) {
          for (const field of dbf.fields) {
            const value = record.values[field.name];
            if (value.issue) findings.push(finding('error', value.issue.code,
              value.issue.code === 'encoding-undeclared'
                ? `记录 ${record.recordNumber} 字段 ${field.name} 含非 ASCII 字节但编码未声明，拒绝猜测接纳`
                : `记录 ${record.recordNumber} 字段 ${field.name} 按 ${value.encoding} 解码失败`,
              { recordNumber: record.recordNumber, field: field.name, rawHex: value.rawHex }));
            if (value.undeclared && value.asciiOnly && !value.null) {
              findings.push(finding('info', 'encoding-undeclared-ascii',
                `记录 ${record.recordNumber} 字段 ${field.name} 编码未声明但仅含 ASCII，按 ASCII 保留`,
                { recordNumber: record.recordNumber, field: field.name }));
            }
          }
          if (record.deleted) {
            findings.push(finding('info', 'dbf-deleted-record', `记录 ${record.recordNumber} 带删除标记（0x2A），保留并按记录号对应，不参与过滤后重排`,
              { recordNumber: record.recordNumber, byteOffset: record.byteOffset }));
          }
        }
        const blockingDbfIssues = new Set(['dbf-truncated', 'dbf-header-terminator-missing', 'dbf-record-out-of-range', 'dbf-field-span-exceeds-record']);
        for (const issue of dbf.issues) findings.push(finding(blockingDbfIssues.has(issue.code) ? 'error' : 'warning', issue.code, JSON.stringify(issue)));
        encodingPlan = plan;
      } catch (error) {
        findings.push(finding('error', 'dbf-invalid', error.message));
      }
    }

    if (shp && shx) {
      if (shp.header.shapeType !== shx.header.shapeType) {
        findings.push(finding('error', 'shx-shape-type-mismatch', 'SHP 与 SHX 头中的形状类型不一致',
          { shp: shp.header.shapeType, shx: shx.header.shapeType }));
      }
      for (const issue of shx.issues) findings.push(finding('warning', issue.code, JSON.stringify(issue)));
      for (const bad of verifyShx(shp, shx)) {
        findings.push(finding('error', bad.code, 'SHX 索引与 SHP 记录头不一致，索引已损坏；几何以 SHP 记录头为准，禁止按行号重连', bad));
      }
    }
    if (shp) {
      for (const issue of shp.issues) findings.push(finding('error', issue.code, JSON.stringify(issue)));
      for (const record of shp.records) {
        if (record.shape.unsupported) {
          findings.push(finding('error', 'shape-type-unsupported', `记录 ${record.recordNumber} 形状类型 ${record.shape.shapeType} 不受支持`, { recordNumber: record.recordNumber }));
        }
        for (const issue of record.issues) {
          const blocking = issue.code.includes('truncated') || issue.code === 'shape-type-unknown'
            || issue.code === 'shp-record-unreadable' || issue.code === 'shape-length-mismatch';
          findings.push(finding(blocking ? 'error' : 'warning',
            issue.code, `记录 ${record.recordNumber}: ${JSON.stringify(issue)}`, { recordNumber: record.recordNumber }));
        }
        if (record.shape.null) {
          findings.push(finding('info', 'null-shape', `记录 ${record.recordNumber} 为 Null Shape，属性仍按记录号保留`,
            { recordNumber: record.recordNumber, byteOffset: record.byteOffset }));
        }
        for (const ring of record.shape.rings ?? []) {
          if (ring.orientationMismatch) {
            findings.push(finding('warning', 'ring-orientation-mismatch',
              `记录 ${record.recordNumber} 环 ${ring.ringIndex} 的 ${ring.role} 方向与 ESRI 约定相反，已按空间包含关系归类`,
              { recordNumber: record.recordNumber, ringIndex: ring.ringIndex, orientation: ring.orientation }));
          }
        }
      }
    }

    const crs = this.#classifyCrs(prjBytes, findings);
    let joined = null;
    if (shp && dbf) {
      joined = joinRecords(shp, dbf);
      for (const bad of joined.findings) {
        findings.push(finding('error', bad.code, 'SHP 与 DBF 记录对应失败：' + JSON.stringify(bad), bad));
      }
      for (const feature of joined.features) {
        if (feature.deleted && !feature.nullShape) {
          // 删除行仍携带几何的情况值得显式提示。
          findings.push(finding('info', 'deleted-record-has-geometry', `记录 ${feature.recordNumber} 已标记删除但仍带几何，两者均保留`,
            { recordNumber: feature.recordNumber }));
        }
      }
    }

    const counts = { error: 0, warning: 0, info: 0 };
    for (const item of findings) counts[item.severity] += 1;
    const status = !ROLES.slice(0, 3).every((role) => staging.components[role]) ? 'incomplete'
      : counts.error > 0 ? 'blocked' : 'ready';
    const report = {
      deliveryId,
      status,
      stagedAt: staging.updatedAt,
      presentRoles: present,
      missingRoles: ROLES.filter((role) => !staging.components[role]),
      encoding: encodingPlan,
      crs,
      stats: {
        shpRecords: shp?.recordCount ?? null,
        shxEntries: shx?.entryCount ?? null,
        dbfRecords: dbf?.header.recordCount ?? null,
        featureCount: joined?.features.length ?? null,
        deletedCount: joined?.features.filter((f) => f.deleted).length ?? null,
        nullShapeCount: joined?.features.filter((f) => f.nullShape).length ?? null,
      },
      findingCounts: counts,
      findings,
    };
    return report;
  }

  async releases() {
    const root = join(this.directory, 'releases');
    let names = [];
    try { names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return Promise.all(names.map((name) => readFile(join(root, name, 'manifest.json'), 'utf8').then(JSON.parse)));
  }

  async current() {
    try {
      const pointer = JSON.parse(await readFile(join(this.directory, 'releases', 'current.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(this.#releasePath(pointer.deliveryId), 'utf8'));
      return { pointer, manifest };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 校验通过才发布；发布为不可变快照，原子切换 current 指针，旧版本保留。
  async publish(deliveryId) {
    const report = await this.validate(deliveryId);
    if (report.status !== 'ready') {
      const error = new Error(`交付 ${deliveryId} 当前为 ${report.status}，存在 ${report.findingCounts.error} 个阻断问题，拒绝发布`);
      error.report = report;
      throw error;
    }
    // 不可变快照：同一交付编号只能发布一次，修订必须以新编号重新走暂存流程。
    try {
      await readFile(this.#releasePath(deliveryId), 'utf8');
      throw new Error(`交付 ${deliveryId} 已发布，发布快照不可变；请使用新的交付编号重新暂存`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const staging = await this.getStaging(deliveryId);
    const components = {};
    for (const role of ROLES) {
      if (staging.components[role]) components[role] = { ...staging.components[role] };
    }
    const shpBytes = await this.#readComponent(staging, 'shp');
    const shxBytes = await this.#readComponent(staging, 'shx');
    const dbfBytes = await this.#readComponent(staging, 'dbf');
    const prjLoaded = await this.#readComponent(staging, 'prj');
    const cpgLoaded = await this.#readComponent(staging, 'cpg');
    const plan = buildEncodingPlan({ cpgBytes: cpgLoaded?.bytes ?? null, ldid: dbfBytes.bytes[29] });
    const shp = parseShp(shpBytes.bytes);
    const shx = parseShx(shxBytes.bytes);
    const dbf = parseDbf(dbfBytes.bytes, makeFieldDecoder(plan));
    const joined = joinRecords(shp, dbf);
    const previous = await this.current();
    const manifest = {
      deliveryId,
      publishedAt: new Date().toISOString(),
      replaced: previous?.pointer.deliveryId ?? null,
      components,
      encoding: plan,
      crs: report.crs,
      shpHeader: shp.header,
      shxHeader: shx.header,
      dbfHeader: { ...dbf.header, fields: dbf.fields },
      stats: report.stats,
      validation: { findingCounts: report.findingCounts, findings: report.findings },
      features: joined.features,
    };
    await this.#writeAtomic(this.#releasePath(deliveryId), JSON.stringify(manifest, null, 2));
    const pointer = { deliveryId, publishedAt: manifest.publishedAt, manifestSha256: digest(Buffer.from(JSON.stringify(manifest))).toString('hex') };
    await this.#writeAtomic(join(this.directory, 'releases', 'current.json'), JSON.stringify(pointer, null, 2));
    return manifest;
  }

  async getRelease(deliveryId) {
    return JSON.parse(await readFile(this.#releasePath(deliveryId), 'utf8'));
  }

  // 记录级溯源：定位到发布快照内的对象摘要与原始字节偏移，并可切出原始字节核验。
  async trace(deliveryId, recordNumber) {
    const manifest = await this.getRelease(deliveryId);
    const feature = manifest.features.find((f) => f.recordNumber === recordNumber);
    if (!feature) throw new Error(`发布 ${deliveryId} 中找不到记录 ${recordNumber}`);
    const provenance = { deliveryId, recordNumber, sources: [] };
    if (feature.shape) {
      const comp = manifest.components.shp;
      provenance.sources.push({
        role: 'shp', objectSha256: comp.sha256,
        recordHeader: { byteOffset: feature.shape.byteOffset, byteLength: feature.shape.byteLength },
        geometryContent: { byteOffset: feature.shape.contentByteOffset, byteLength: feature.shape.contentLengthWords * 2 },
      });
    }
    if (feature.attributes) {
      const comp = manifest.components.dbf;
      provenance.sources.push({
        role: 'dbf', objectSha256: comp.sha256,
        record: { byteOffset: feature.attributes.byteOffset, byteLength: feature.attributes.byteLength, deleted: feature.attributes.deleted },
        fields: Object.fromEntries(Object.entries(feature.attributes.values).map(([name, value]) =>
          [name, { byteOffset: value.byteOffset, byteLength: value.byteLength }])),
      });
    }
    return provenance;
  }

  // 按溯源信息切出原始字节并重新计算摘要，证明字节位置可查回。
  async readSourceBytes(deliveryId, role, byteOffset, byteLength) {
    const manifest = await this.getRelease(deliveryId);
    const component = manifest.components[role];
    if (!component) throw new Error(`发布 ${deliveryId} 不含 ${role} 组件`);
    const bytes = await this.archive.read(component.sha256);
    const slice = bytes.subarray(byteOffset, byteOffset + byteLength);
    return { bytes: slice, sha256: digest(slice), objectSha256: component.sha256 };
  }
}
