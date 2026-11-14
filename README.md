# 成套地理交付文件的记录对齐资料

boundary-files 用于合作资料的本地查看、来源保存与成套结构化采集。外包每月交付的 SHP、SHX、DBF、PRJ、CPG 被视为**一份交付**：文件可以分批到齐并暂存，整套几何与属性的对应关系校验通过后才发布；已发布版本是不可变快照，不会被后来不完整的交付覆盖。

## 运行环境

使用 Node.js 22，无第三方运行时依赖。依赖已锁定；首次准备执行 `npm ci --ignore-scripts`，正式运行无需下载资料或软件。全部样例使用合成数据与本机来源，不连接生产系统。

```bash
npm run check
npm test
npm run demo
```

`npm run demo` 在临时目录实际读取资料、暂存、校验、发布并做字节级溯源，退出时清理临时内容。正常演示应在数秒内结束。

## 资料操作

### 既有查看与字节归档（保持可用）

```bash
npm start -- inspect fixtures/plots.shp
npm start -- capture fixtures/plots.shp .local/archive
npm start -- list .local/archive
```

`capture` 只表示来源字节已保存，不声称领域流程已自动完成。

### 成套采集：暂存 → 校验 → 发布

```bash
# 单文件分批暂存（角色：shp/shx/dbf/prj/cpg）
npm start -- stage 2026-10 .local/archive shp:fixtures/plots2.shp shx:fixtures/plots2.shx
npm start -- stage 2026-10 .local/archive dbf:fixtures/plots2.dbf prj:fixtures/plots2.prj
# 编码文件迟到，后续补齐
npm start -- stage 2026-10 .local/archive cpg:fixtures/plots.cpg

# 或整目录一次暂存（无法识别的扩展名只登记，不参与解析）
npm start -- stage-dir 2026-10 fixtures .local/archive

npm start -- validate 2026-10 .local/archive
npm start -- publish 2026-10 .local/archive
npm start -- current .local/archive
npm start -- releases .local/archive
npm start -- trace 2026-10 2 .local/archive
```

## 对应关系与边界处理

- **按记录号连接，不按过滤后的行号**：DBF 删除标记（`0x2A`）的记录原样保留并标注 `deleted`；这正是“过滤后再按行号连接导致后续地块单位名称错位”的防线。
- **SHX 索引逐条核对**：偏移或内容长度与 SHP 记录头不一致即报 `shx-entry-mismatch` 并阻断发布；几何事实以 SHP 记录头为准，不允许用损坏索引重连。
- **Null Shape 保留**：记录号与属性不消失，几何标记 `null: true`。
- **多部件与孔洞**：Polygon/PolygonZ 按空间包含关系区分外环与孔洞（方向只作可疑提示，不作唯一依据），多外壳分组输出。
- **Z、M 与无数据值不静默丢弃**：逐点保留 Z/M；ESRI 哨兵（`-10^38`，兼容 `-10^39` 量级）识别为无数据并给索引，M 区间反序（min>max）与 M 段整体缺席都显式标记；原始范围值保留在 `zRange/mRange`。
- **编码不猜测**：CPG 为唯一声明来源，LDID 仅作提示暴露。未声明编码且字段含非 ASCII 字节时阻断发布并保留原始 hex；纯 ASCII 字段按 ASCII 保留并标注。CPG 无法识别或 fatal 解码失败同样阻断，绝不产出乱码结果。
- **坐标参考缺失不默认经纬度**：缺 PRJ 时 CRS 标记 `unknown`（warning，不阻断），原坐标原样保留；PRJ 首关键字无法识别时保留 WKT 原文与原坐标。
- **分批与版本**：暂存清单记录每个角色的修订链；同一交付编号只能发布一次，修订须以新编号重新走流程。`current.json` 原子切换，`releases/` 中旧快照永久可读。
- **字节溯源**：发布清单为每条记录保存 SHP/DBF 的对象摘要、记录头与字段级字节偏移，`trace` 可定位，`readSourceBytes` 可切回原始字节并重算摘要。

校验问题分三级：`error` 阻断发布，`warning`（如缺 PRJ/CPG、环方向可疑）不阻断但留痕，`info`（删除行、Null Shape）为事实记录。SHP/SHX/DBF 三者缺一即为 `incomplete`。

## 目录约定

- `src/shapefile.js`：SHP/SHX/DBF 二进制解析、索引核对与记录号连接。
- `src/encoding.js`：CPG/LDID 编码方案与 fatal 字段解码（未声明不猜测）。
- `src/intake.js`：暂存、整套校验、不可变发布与记录级溯源。
- `src/archive.js`：内容对象、来源回执与完整性检查。
- `src/demo.js`：删除行、Null Shape、损坏索引、迟到 CPG、缺 PRJ 与版本保留的端到端演示。
- `src/domain.js`：既有领域读取和查看接口。
- `fixtures/`：本地合成资料；`plots2.*` 为 PolygonZ 多部件/孔洞/无数据样例（故意不含 CPG 以演示迟到编码文件）。
- `test/`：行为验证，使用独立临时目录。

## Linux 环境

`Dockerfile` 使用 Node.js 22 镜像，可执行 `docker build -t boundary-files:local .` 后运行 `docker run --rm --network none boundary-files:local npm test`。测试与演示只使用临时目录与本机文件，不监听网络端口。
