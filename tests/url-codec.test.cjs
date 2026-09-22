// Run with Node.js 22+: node --test tests/url-codec.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { deflateSync } = require('node:zlib');
const { setImmediate: tick } = require('node:timers/promises');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const codecs = scripts.slice(0, 3).join('\n');
const main = scripts[3];
const plain = value => JSON.parse(JSON.stringify(value));
function loadCodecs(overrides = {}) {
  const context = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, URLSearchParams, Blob,
    CompressionStream, DecompressionStream, ...overrides });
  vm.runInContext(codecs + '\nglobalThis.api = { FolderUrlCodec, TagUrlCodec, ListUrlCodec };', context);
  return context.api;
}
const { FolderUrlCodec: foldersCodec, TagUrlCodec: tagsCodec, ListUrlCodec: codec } = loadCodecs();
const rawHash = value => '#list=j.' + Buffer.from(JSON.stringify(value)).toString('base64url');
const compressedHash = bytes => '#list=z.' + deflateSync(bytes).toString('base64url');
const manyTags = Array.from({ length: 60 }, (_, index) => `${index < 30 ? '実況' : '作品'}：動画タイトル${index + 1}`);

function functionSource(name) {
  const start = main.search(new RegExp('      (?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, name);
  const tail = main.slice(start);
  const end = tail.slice(7).search(/\n      (?:async )?function /);
  assert.notEqual(end, -1, name);
  return tail.slice(0, end + 7) + '\n';
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrideCodec = codec) {
  let href = 'file:///LocalFlix/index.html';
  const db = new Map(), reads = [], history = [];
  const location = { get href() { return href; }, get hash() { return new URL(href).hash; },
    set hash(hash) { const url = new URL(href); url.hash = hash; href = url.href; }, replace(url) { href = url; } };
  const context = vm.createContext({ FolderUrlCodec: foldersCodec, TagUrlCodec: tagsCodec,
    ListUrlCodec: overrideCodec, URL, location,
    history: { pushState(_, __, url) { href = url; history.push(['push', url]); },
      replaceState(_, __, url) { href = url; history.push(['replace', url]); } },
    crypto: { randomUUID: () => 'unexpected-new-root' }, db, reads });
  vm.runInContext(`
    let folderView=null,viewRoot=null,tagTypes=[],folderStateInitialized=false,viewEpoch=0,
      appliedHash=null,urlRevision=0,urlError=false,viewStorageWarning='',folderBusy=false,
      resetCount=0,scanCount=0,legacyCount=0,currentVideoKey='playing',directorySources=[];
    const updateSourceDisplay=()=>{},setHeaderCollapsed=()=>{},renderTagTypes=()=>{},showNotice=()=>{};
    const setBusy=value=>{folderBusy=value};
    const resetFolderView=()=>{viewEpoch++;resetCount++;currentVideoKey=null};
    const dbGet=async(store,key)=>{reads.push(key);return db.get(key)};
    const restoreLegacyFolders=async()=>{legacyCount++};
    const scanSources=async()=>{
      scanCount++;folderBusy=false;
      directorySources=(folderView?.folders||[]).map(path=>({id:viewRoot.cacheId+':'+path,relativeRoot:path,name:path}));
    };
  ` + ['setFolderHash', 'compactFolderHash', 'writeFolderHash', 'restoreFolders', 'videoTagPath', 'videoTagKey'].map(functionSource).join('\n') + `
    const pendingCompactions=new Set(),originalCompact=compactFolderHash;
    compactFolderHash=(...args)=>{
      const pending=originalCompact(...args);pendingCompactions.add(pending);
      pending.finally(()=>pendingCompactions.delete(pending));return pending;
    };
    globalThis.api={writeFolderHash,restoreFolders,videoTagKey,
      flushCompactions:()=>Promise.all([...pendingCompactions]),
      setTags:tags=>{tagTypes=tags},play:()=>{currentVideoKey='playing'},
      state:()=>({folderView,viewRoot,tagTypes,viewEpoch,urlRevision,urlError,resetCount,scanCount,legacyCount,currentVideoKey})};
  `, context);
  return { ...context.api, db, reads, history, location,
    navigate(hash) { location.hash = hash; } };
}

test('inline scripts parse', () => { for (const script of scripts) new Function(script); });

test('all legacy URL variants and compact variants round-trip', async () => {
  for (const folders of [null, [], ['.'], ['旅行/2026', '実況/モンハン']]) {
    for (const tags of [[], ['お気に入り'], ['実況：モンハン', '実況:Division2', '特殊：& + # 🎬', 'A"<B>']]) {
      const expected = { folders: folders === null ? null : plain(foldersCodec.normalize(folders)), tags: plain(tagsCodec.normalize(tags)) };
      const legacy = codec.legacyHash(folders, tags);
      assert.deepEqual(plain(await codec.decodeHash(legacy)), expected);
      const compact = await codec.encodeHash(folders, tags);
      assert(compact.length <= legacy.length);
      assert.deepEqual(plain(await codec.decodeHash(compact)), expected);
      assert.deepEqual(plain(await codec.decodeHash(rawHash([1, folders, tags]))), expected);
      assert.deepEqual(plain(await codec.decodeHash(compressedHash(Buffer.from(JSON.stringify([1, folders, tags]))))), expected);
    }
  }
});

test('normalization and shorter URL are deterministic in the same runtime', async () => {
  const a = await codec.encodeHash(['B', '日本語/🎬', 'B'], ['e\u0301', '実況：モンハン', 'é']);
  const b = await codec.encodeHash(['日本語\\🎬/', 'B'], ['実況：モンハン', 'é']);
  assert.equal(a, b);
  const folders = ['動画/ゲーム/実況', '動画/旅行/2026'];
  const old = codec.legacyHash(folders, manyTags), short = await codec.encodeHash(folders, manyTags);
  assert(short.startsWith('#list=z.'));
  assert(short.length < old.length / 2);
});

test('compression unavailable uses a readable non-compressed fallback', async () => {
  const fallback = loadCodecs({ CompressionStream: undefined, DecompressionStream: undefined }).ListUrlCodec;
  const hash = await fallback.encodeHash(['動画'], manyTags);
  assert(!hash.startsWith('#list=z.'));
  assert.deepEqual(plain(await fallback.decodeHash(hash)).tags, plain(tagsCodec.normalize(manyTags)));
  const compressed = await codec.encodeHash(['動画'], manyTags);
  await assert.rejects(fallback.decodeHash(compressed), error => error.code === 'URL_COMPRESSION_UNAVAILABLE');
  const broken = loadCodecs({ CompressionStream: class { constructor() { throw Error('unsupported'); } } }).ListUrlCodec;
  assert.equal(await broken.encodeHash(['動画'], manyTags), hash);
});

test('malformed, duplicate, oversized, and unsafe URL payloads fail closed', async () => {
  const good = await codec.encodeHash(['A'], manyTags);
  for (const hash of ['#list=z.!', '#list=j.a', '#list=x.AA', '#list=z.AA', '#list=',
    good + '&tags=AA', good + '&list=j.AA', '#folders=AA&folders=AA', '#unknown=1',
    '#list=j.' + 'A'.repeat(100001), rawHash([2, ['A'], []]), rawHash([1, ['../private'], []]),
    rawHash([1, ['/absolute'], []]), rawHash([1, ['A'], ['']]), rawHash([1, [], Array(101).fill('tag')]),
    rawHash([1, [], [], 'extra']), '#list=j._w', compressedHash(Buffer.alloc(100000, 65))]) {
    await assert.rejects(codec.decodeHash(hash), hash.slice(0, 80));
  }
  await assert.rejects(codec.decodeHash(good.slice(0, -2)));
});

test('old URL becomes compact without losing the original base, assignments, or playback', async () => {
  const paths = ['動画/実況'];
  const token = foldersCodec.encode(paths);
  const saved = { name: 'Videos', cacheId: 'existing-root-id', handle: { kind: 'directory', queryPermission() {} } };
  const h = harness();
  h.db.set('folderView:' + token, saved);
  const assignmentKey = JSON.stringify([saved.cacheId, '動画/実況/clip.mp4']);
  const assignments = [[assignmentKey, ['実況：モンハン']]];
  h.db.set('videoTagAssignments.v1', assignments);
  h.navigate(codec.legacyHash(paths, manyTags));
  await h.restoreFolders();
  await h.flushCompactions();
  assert.equal(h.state().viewRoot.cacheId, saved.cacheId);
  assert.deepEqual(h.reads, ['folderView:' + token]);
  assert.equal(h.db.get('videoTagAssignments.v1'), assignments);
  const video = { sourceId: saved.cacheId + ':' + paths[0], relativePath: 'clip.mp4' };
  assert.equal(h.videoTagKey(video), assignmentKey);
  const short = h.location.hash;
  assert(short.startsWith('#list=z.'));
  assert(h.history.every(([action]) => action === 'replace'));
  h.play();
  h.navigate(codec.legacyHash(paths, ['実況：モンハン']));
  await h.restoreFolders();
  assert.equal(h.state().resetCount, 1);
  assert.equal(h.state().scanCount, 1);
  assert.equal(h.state().currentVideoKey, 'playing');
  // A new page opening the compressed bookmark must use the exact same persisted key.
  const reloaded = harness();
  reloaded.db.set('folderView:' + token, saved);
  reloaded.navigate(short); await reloaded.restoreFolders();
  assert.equal(reloaded.state().viewRoot.cacheId, saved.cacheId);
  assert.equal(reloaded.videoTagKey(video), assignmentKey);
});

test('compressed legacy/no-base distinction is retained', async () => {
  const h = harness();
  h.navigate(await codec.encodeHash(null, ['お気に入り']));
  await h.restoreFolders();
  assert.equal(h.state().folderView, null);
  assert.equal(h.state().legacyCount, 1);
});

test('an older compaction cannot overwrite a newer edit or unprocessed navigation', async () => {
  const tasks = [];
  const h = harness({ ...codec, encodeHash(folders, tags) { const d = deferred(); tasks.push({ ...d, folders, tags }); return d.promise; } });
  const token = foldersCodec.encode(['A']);
  h.setTags(['first']); h.writeFolderHash(token);
  h.setTags(['second']); h.writeFolderHash(token);
  tasks[1].resolve(rawHash([1, ['A'], ['second']])); await tick();
  const latest = h.location.hash;
  tasks[0].resolve(rawHash([1, ['A'], ['first']])); await tick();
  assert.equal(h.location.hash, latest);
  assert.equal(h.history.filter(([action]) => action === 'push').length, 2);
  assert.equal(h.history.filter(([action]) => action === 'replace').length, 1);
  h.setTags(['third']); h.writeFolderHash(token);
  h.navigate('#folders=not-yet-restored');
  tasks[2].resolve(rawHash([1, ['A'], ['third']])); await tick();
  assert.equal(h.location.hash, '#folders=not-yet-restored');
});

test('slow decoding cannot apply an older URL or an older error', async () => {
  const tasks = [];
  const h = harness({ ...codec, decodeHash(hash) { const d = deferred(); tasks.push(d); return d.promise; },
    encodeHash: async (folders, tags) => codec.legacyHash(folders, tags) });
  h.navigate('#list=z.first'); const first = h.restoreFolders();
  h.navigate('#list=z.second'); const second = h.restoreFolders();
  tasks[1].resolve({ folders: null, tags: ['new'] }); await second;
  tasks[0].resolve({ folders: ['old'], tags: [] }); await first;
  assert.deepEqual(plain(h.state().tagTypes), ['new']);
  assert.equal(h.state().legacyCount, 1);
  h.navigate('#list=z.bad'); const bad = h.restoreFolders();
  h.setTags(['edited']); h.writeFolderHash(null);
  tasks[2].reject(Error('invalid old URL')); await bad;
  assert.equal(h.state().urlError, false);
  assert.deepEqual(plain(h.state().tagTypes), ['edited']);
});
