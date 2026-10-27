import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encodeZip, decodeZip, WORKFLOW_ZIP_LIMITS } from '../src/workflows/workflow-zip.mjs';

const files = () => [{ name: 'workflow.json', data: Buffer.from('{"title":"中文工作流"}') },
  { name: 'inputs/', data: Buffer.alloc(0) }, { name: 'inputs/说明.txt', data: Buffer.from('需要保留的输入素材\n'.repeat(100)) },
  { name: 'outputs/data.bin', data: Buffer.from([0, 1, 255, 0, 128]) }];
const bad = run => assert.throws(run, error => error.httpStatus === 400 || error.httpStatus === 413);
function python(script, input) {
  const result = spawnSync('python3', ['-c', script], { input, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
}

test('workflow packages are deterministic standard ZIP bytes and preserve binary, Unicode and empty folders', () => {
  const entries = files(), before = entries.map(row => ({ name: row.name, data: Buffer.from(row.data) }));
  const archive = encodeZip(entries); assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.deepEqual(decodeZip(archive), before); assert.deepEqual(entries, before);
  assert.deepEqual(encodeZip(entries), archive); assert.deepEqual(decodeZip(encodeZip([])), []);
  assert.equal(WORKFLOW_ZIP_LIMITS.maxEntries, 10000);
});

test('Python zipfile reads our ZIP and our decoder reads Python store, deflate and streaming descriptors', () => {
  const read = python('import sys,io,zipfile,json\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nprint(json.dumps({n:z.read(n).hex() for n in z.namelist()},ensure_ascii=False))', encodeZip(files()));
  assert.deepEqual(JSON.parse(read.toString()), Object.fromEntries(files().map(row => [row.name, row.data.toString('hex')])));
  for (const streaming of [false, true]) {
    const archive = python(`import sys,io,zipfile\nclass Stream(io.BytesIO):\n def seekable(self): return False\n def seek(self,*args): raise io.UnsupportedOperation()\nb=${streaming ? 'Stream' : 'io.BytesIO'}()\nwith zipfile.ZipFile(b,'w') as z:\n z.writestr('plain.txt','stored bytes',compress_type=zipfile.ZIP_STORED)\n z.writestr('素材/中文.txt','hello '*50,compress_type=zipfile.ZIP_DEFLATED)\n z.writestr('empty/',b'')\nsys.stdout.buffer.write(b.getvalue())`);
    assert.deepEqual(decodeZip(archive).map(row => [row.name, row.data.toString()]), [
      ['plain.txt', 'stored bytes'], ['素材/中文.txt', 'hello '.repeat(50)], ['empty/', ''],
    ]);
  }
});

test('unsafe names, case or Unicode aliases and file-directory collisions are rejected before extraction', () => {
  const make = names => names.map(name => ({ name, data: Buffer.alloc(0) }));
  for (const names of [['../outside'], ['/absolute'], ['C:/drive'], ['a\\outside'], ['a/../outside'], ['a//b'], ['a/./b'],
    ['a\0b'], ['\ud800.txt'], ['x:stream'], ['inputs/CON.txt'], ['trailing.'], ['same', 'same'], ['Readme', 'README'], ['é.txt', 'e\u0301.txt'],
    ['file', 'file/inside'], ['folder/item', 'folder'], ['folder/', 'FOLDER'], ['Inputs/one', 'inputs/two'], ['é/one', 'e\u0301/two']]) bad(() => encodeZip(make(names)));
  // The reader validates its own paths; it does not rely on the writer's checks.
  for (const name of ['../outside', '/absolute', 'C:/drive', 'a\\outside', 'x:stream']) {
    const archive = python('import sys,io,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:z.writestr(sys.argv[0],b"unsafe")\nsys.stdout.buffer.write(b.getvalue())'.replace('sys.argv[0]', JSON.stringify(name)));
    bad(() => decodeZip(archive));
  }
});

test('malformed byte mutations never escape the bounded decoder as internal range or allocation errors', () => {
  const archive = encodeZip(files());
  for (let index = 0; index < archive.length; index++) {
    const changed = Buffer.from(archive); changed[index] ^= 0x80;
    try { decodeZip(changed); } catch (error) { assert([400, 413].includes(error.httpStatus), `${index}: ${error.stack}`); }
  }
});

test('truncation, local-central mismatches, encryption, symlinks, unsupported methods and ZIP64 are rejected', () => {
  const original = encodeZip([{ name: 'safe.txt', data: Buffer.from('content') }]);
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const mutations = [
    data => data.subarray(0, data.length - 1),
    data => Buffer.concat([data, Buffer.from('trailing')]),
    data => { data[30] ^= 1; return data; },
    data => { data.writeUInt16LE(1, 6); data.writeUInt16LE(1, central + 8); return data; },
    data => { data.writeUInt16LE(99, 8); data.writeUInt16LE(99, central + 10); return data; },
    data => { data.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38); return data; },
    data => { data.writeUInt16LE(45, 4); data.writeUInt16LE(45, central + 6); return data; },
    data => { data.writeUInt32LE(0xffffffff, central + 24); return data; },
    data => { data.writeUInt16LE(1, data.length - 18); return data; },
    data => { data.writeUInt32LE(1, central + 42); return data; },
  ];
  for (const mutate of mutations) bad(() => decodeZip(mutate(Buffer.from(original))));
});

test('CRC corruption, overlapping locals and unreferenced prefix bytes fail closed', () => {
  const archive = encodeZip([{ name: 'a.txt', data: Buffer.from('first') }, { name: 'b.txt', data: Buffer.from('second') }]);
  const broken = Buffer.from(archive); broken[35] ^= 0xff; bad(() => decodeZip(broken));
  const central1 = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])), central2 = central1 + 46 + 'a.txt'.length;
  const overlap = Buffer.from(archive); overlap.writeUInt32LE(0, central2 + 42); bad(() => decodeZip(overlap));
  bad(() => decodeZip(Buffer.concat([Buffer.from('SFX'), archive])));
});

test('resource bounds use real inflated bytes and limit archive, individual files, totals and counts', () => {
  for (const limits of [{ maxCompressedBytes: 10 }, { maxFileBytes: 4 }, { maxUncompressedBytes: 5 }, { maxEntries: 1 }]) {
    bad(() => encodeZip(files(), limits)); bad(() => decodeZip(encodeZip(files()), limits));
  }
  const archive = encodeZip([{ name: 'bomb.txt', data: Buffer.from('x'.repeat(4096)) }]);
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(1, 22); archive.writeUInt32LE(1, central + 24);
  assert.throws(() => decodeZip(archive, { maxFileBytes: 8 }), error => error.httpStatus === 413);
  for (const limits of [{ unknown: 1 }, { maxEntries: -1 }, { maxFileBytes: Infinity }]) bad(() => encodeZip([], limits));
});
