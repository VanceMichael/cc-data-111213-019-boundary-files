import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Archive } from './archive.js';
import { inspect, sample } from './domain.js';
import { IntakeStore, ROLES } from './intake.js';

const [command = 'help', ...args] = process.argv.slice(2);

function parseFlags(flags) {
  const options = {};
  for (const item of flags) {
    const match = item.match(/^--([A-Za-z0-9-]+)(?:=(.*))?$/);
    if (!match) throw new Error(`无法识别的参数：${item}`);
    options[match[1]] = match[2] ?? true;
  }
  return options;
}

async function run() {
  if (command === 'help') {
    console.log(JSON.stringify({
      usage: 'npm start -- <命令> [位置参数] [--标志]',
      commands: [
        'inspect <shp路径>',
        'capture <文件路径> [归档目录]',
        'list [归档目录]',
        'stage-dir <交付编号> <目录> [归档目录]',
        'stage <交付编号> <角色:文件> [归档目录]   可重复多个 --file=shp:a.shp',
        'validate <交付编号> [归档目录]',
        'publish <交付编号> [归档目录]',
        'releases [归档目录]',
        'current [归档目录]',
        'trace <交付编号> <记录号> [归档目录]',
        'demo',
      ],
    }, null, 2));
  } else if (command === 'inspect') {
    if (!args[0]) throw new Error('需要资料路径');
    console.log(JSON.stringify(await inspect(resolve(args[0])), null, 2));
  } else if (command === 'capture') {
    if (!args[0]) throw new Error('需要资料路径');
    const [file, directory = '.local/archive'] = args;
    const inventory = await inspect(resolve(file));
    const receipt = await new Archive(directory).accept(await readFile(file),
      { source: resolve(file), inventory });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(await new Archive(args[0] || '.local/archive').receipts(), null, 2));
  } else if (command === 'stage-dir') {
    const [deliveryId, directory, archiveDir = '.local/archive'] = args;
    if (!deliveryId || !directory) throw new Error('用法：stage-dir <交付编号> <目录> [归档目录]');
    const store = new IntakeStore(archiveDir);
    console.log(JSON.stringify(await store.stageDirectory(deliveryId, resolve(directory)), null, 2));
  } else if (command === 'stage') {
    // 用法：stage <交付编号> [归档目录] <角色:文件>...，或使用 --file=<角色:文件>
    if (!args[0]) throw new Error('用法：stage <交付编号> [归档目录] <角色:文件>...');
    const deliveryId = args[0];
    const rest = args.slice(1);
    const flags = parseFlags(rest.filter((item) => item.startsWith('--')));
    const positionals = rest.filter((item) => !item.startsWith('--'));
    const pairs = [...positionals, ...Object.values(flags)];
    if (pairs.length === 0) throw new Error('至少提供一个 <角色:文件> 或 --file=<角色:文件>');
    const filePairs = [];
    let archiveDir = '.local/archive';
    for (const pair of pairs) {
      const [role, ...fileParts] = pair.split(':');
      if (ROLES.includes(role.toLowerCase())) filePairs.push([role, fileParts.join(':')]);
      else if (!pair.includes(':') && filePairs.length === 0) archiveDir = pair;
      else throw new Error(`未知角色或参数：${pair}`);
    }
    const store = new IntakeStore(archiveDir);
    const results = [];
    for (const [role, file] of filePairs) {
      results.push(await store.stage(deliveryId, role, await readFile(resolve(file)), file));
    }
    console.log(JSON.stringify(results, null, 2));
  } else if (command === 'validate') {
    const [deliveryId, archiveDir = '.local/archive'] = args;
    if (!deliveryId) throw new Error('需要交付编号');
    console.log(JSON.stringify(await new IntakeStore(archiveDir).validate(deliveryId), null, 2));
  } else if (command === 'publish') {
    const [deliveryId, archiveDir = '.local/archive'] = args;
    if (!deliveryId) throw new Error('需要交付编号');
    console.log(JSON.stringify(await new IntakeStore(archiveDir).publish(deliveryId), null, 2));
  } else if (command === 'releases') {
    console.log(JSON.stringify(await new IntakeStore(args[0] || '.local/archive').releases(), null, 2));
  } else if (command === 'current') {
    console.log(JSON.stringify(await new IntakeStore(args[0] || '.local/archive').current(), null, 2));
  } else if (command === 'trace') {
    const [deliveryId, recordText, archiveDir = '.local/archive'] = args;
    if (!deliveryId || !recordText) throw new Error('用法：trace <交付编号> <记录号> [归档目录]');
    const store = new IntakeStore(archiveDir);
    const recordNumber = Number(recordText);
    const provenance = await store.trace(deliveryId, recordNumber);
    // 同时切回 SHP 记录头原始字节，演示字节位置可查回。
    const shpSource = provenance.sources.find((s) => s.role === 'shp');
    let sampleBytes = null;
    if (shpSource) {
      const cut = await store.readSourceBytes(deliveryId, 'shp',
        shpSource.recordHeader.byteOffset, Math.min(8, shpSource.recordHeader.byteLength));
      sampleBytes = cut.bytes.toString('hex');
    }
    console.log(JSON.stringify({ provenance, sampleRecordHeaderHex: sampleBytes }, null, 2));
  } else if (command === 'demo') {
    const { runIntakeDemo } = await import('./demo.js');
    await runIntakeDemo();
  } else {
    throw new Error('支持 inspect、capture、list、stage、stage-dir、validate、publish、releases、current、trace、demo');
  }
}
run().catch((error) => {
  console.error(error.message);
  if (error.report) console.error(JSON.stringify(error.report, null, 2));
  process.exitCode = 1;
});
