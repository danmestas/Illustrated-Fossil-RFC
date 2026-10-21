import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve(import.meta.dirname, '../scripts/build-repo.mjs');
const scratch = os.tmpdir();

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, FOSSIL_HOME: root, FOSSIL_USER: 'review', TMPDIR: root };
  const f = (args, cwd = root) => execFileSync('fossil', args, {
    cwd, env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const make = (name, date) => {
    const repo = path.join(root, `${name}.fossil`), work = path.join(root, name);
    fs.mkdirSync(work);
    f(['init', '--date-override', date, '-A', 'review', repo]);
    f(['open', repo], work);
    f(['settings', 'autosync', 'off'], work);
    return { repo, work };
  };
  const commit = (work, date, message, extra = []) => {
    f(['addremove'], work);
    f(['commit', '-m', message, '--date-override', date, '--no-warnings', '--allow-older', ...extra], work);
    return f(['sqlite3', 'SELECT uuid FROM blob WHERE rid=(SELECT value FROM vvar WHERE name=\'checkout\')'], work);
  };
  const original = make('original', '2000-01-01T00:00:00');
  fs.writeFileSync(path.join(original.work, 'draft-fossil-test-00.txt'), 'original\n');
  commit(original.work, '2000-01-02T00:00:00', 'original');
  const source = make('source', '2000-01-03T00:00:00');
  const dir = path.join(source.work, 'docs/rfcs');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, text) => fs.writeFileSync(path.join(dir, `draft-fossil-${name}-00.txt`), text);
  write('test', 'base\n');
  const base = commit(source.work, '2000-01-04T00:00:00', 'base');
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(site, 'rfcs/repos'), { recursive: true });
  const isolatedScript = path.join(site, 'scripts/build-repo.mjs');
  fs.copyFileSync(script, isolatedScript);
  const out = path.join(site, 'rfcs/repos/rfcs.fossil');
  const run = (extra = {}) => execFileSync('node', [isolatedScript], {
    cwd: root, env: { ...env, ZIT_REPO: source.repo, ORIGINALS_REPO: original.repo,
      OUTPUT_REPO: out, ...extra }, encoding: 'utf8', timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hashes = () => f(['sqlite3', '-R', out,
    "SELECT b.uuid FROM event e JOIN blob b ON b.rid=e.objid WHERE e.type='ci' ORDER BY e.rowid"]).split('\n');
  const snapshot = (repo, prefix = '') => f(['sqlite3', '-R', repo,
    `SELECT substr(filename, ${prefix.length + 1}), uuid FROM files_of_checkin('trunk') WHERE filename GLOB '${prefix}draft-fossil-*-00.txt' OR filename GLOB '${prefix}erratum/*' ORDER BY filename`]);
  return { root, env, f, source, original, out, dir, write, commit, run, hashes, snapshot, base };
}

test('replay actor is independent of host identity and preserves historical authors', { timeout: 120000 }, t => {
  const x = fixture(t);
  const unrelated = { USER: 'ciworker', LOGNAME: 'ciworker', FOSSIL_USER: 'not-a-staged-user' };
  x.run(unrelated);
  const before = x.hashes();
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
  x.write('test', 'next revision\n');
  x.commit(x.source.work, '2000-01-05T00:00:00', 'historical update');
  x.run(unrelated);
  assert.deepEqual(x.hashes().slice(0, before.length), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
  assert.equal(x.f(['sqlite3', '-R', x.out,
    "SELECT user FROM event WHERE type='ci' AND comment='historical update'"]), 'review');
  const after = x.hashes();
  x.run(unrelated);
  assert.deepEqual(x.hashes(), after);
});

for (const mode of ['fresh replay', 'incremental append']) {
  test(`directory and file transitions preserve the trunk snapshot during ${mode}`, { timeout: 120000 }, t => {
    const x = fixture(t);
    const entry = path.join(x.dir, 'erratum/entry');
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'text'), 'nested\n');
    x.commit(x.source.work, '2000-01-05T00:00:00', 'nested erratum');
    let before = [];
    if (mode === 'incremental append') {
      x.run();
      before = x.hashes();
    }
    fs.rmSync(entry, { recursive: true });
    fs.writeFileSync(entry, 'flat\n');
    x.commit(x.source.work, '2000-01-06T00:00:00', 'flatten erratum');
    x.run();
    assert.deepEqual(x.hashes().slice(0, before.length), before);
    assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
    fs.rmSync(entry);
    fs.mkdirSync(entry);
    fs.writeFileSync(path.join(entry, 'text'), 'nested again\n');
    x.commit(x.source.work, '2000-01-07T00:00:00', 'expand erratum');
    x.run();
    assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
    const after = x.hashes();
    x.run();
    assert.deepEqual(x.hashes(), after);
  });
}

test('sanitization physically removes old credentials without rewriting check-ins', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  const before = x.hashes();
  const marker = 'OLD_PASSWORD_MARKER_a1b2c3d4e5f6';
  x.f(['sqlite3', '-R', x.out, `UPDATE user SET pw='${marker}',cap='s' WHERE login='dmestas'`]);
  assert.ok(fs.readFileSync(x.out).includes(Buffer.from(marker)));
  x.run();
  assert.equal(x.f(['sqlite3', '-R', x.out,
    "SELECT count(*) FROM user WHERE login<>'nobody' AND (pw<>'' OR cap<>'')"]), '0');
  assert.ok(!fs.readFileSync(x.out).includes(Buffer.from(marker)), 'old password bytes remain in the output');
  assert.deepEqual(x.hashes(), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
});

test('late branch integration preserves the published prefix and resolved trunk snapshot', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.write('temporary', 'deleted before landing\n');
  x.commit(x.source.work, '2000-01-05T00:00:00', 'side addition', ['--branch', 'side']);
  x.f(['rm', '--hard', 'docs/rfcs/draft-fossil-temporary-00.txt'], x.source.work);
  x.commit(x.source.work, '2000-01-06T00:00:00', 'side deletion');
  x.f(['update', 'trunk'], x.source.work);
  x.write('test', 'current trunk\n');
  x.commit(x.source.work, '2000-01-07T00:00:00', 'trunk advance');
  x.run();
  const before = x.hashes();
  x.f(['merge', 'side'], x.source.work);
  x.commit(x.source.work, '2000-01-08T00:00:00', 'merge without draft delta', ['--allow-empty']);
  x.run();
  assert.deepEqual(x.hashes().slice(0, before.length), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
  const after = x.hashes();
  x.run();
  assert.deepEqual(x.hashes(), after);
});

test('a branch-only draft deleted before landing stays absent', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  x.write('temporary', 'branch only\n');
  x.commit(x.source.work, '2000-01-05T00:00:00', 'add temporary', ['--branch', 'side']);
  x.f(['rm', '--hard', 'docs/rfcs/draft-fossil-temporary-00.txt'], x.source.work);
  x.commit(x.source.work, '2000-01-06T00:00:00', 'remove temporary');
  x.f(['update', 'trunk'], x.source.work);
  x.f(['merge', 'side'], x.source.work);
  x.commit(x.source.work, '2000-01-07T00:00:00', 'integrate resolved snapshot', ['--allow-empty']);
  x.run();
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
});

test('backdated trunk descendants append to the actual generated leaf', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  const before = x.hashes();
  x.write('test', 'backdated descendant\n');
  x.commit(x.source.work, '2000-01-03T12:00:00', 'backdated child');
  x.run();
  assert.deepEqual(x.hashes().slice(0, before.length), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
  x.write('test', 'still later by ancestry\n');
  x.commit(x.source.work, '2000-01-03T13:00:00', 'second child');
  x.run();
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
});

test('fresh reconstruction and incremental no-op retain identical check-ins', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  const before = x.hashes();
  x.run();
  assert.deepEqual(x.hashes(), before);
  fs.rmSync(x.out);
  x.run();
  assert.deepEqual(x.hashes(), before);
});

test('bootstrap validates the legacy tip and preserves all its artifacts', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  x.f(['sqlite3', '-R', x.out, "DELETE FROM config WHERE name='rfc-projection-v1'"]);
  const before = x.hashes();
  const bytes = fs.readFileSync(x.out);
  assert.throws(() => x.run(), /ZIT_CHECKPOINT/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
  x.write('test', 'new trunk\n');
  const newer = x.commit(x.source.work, '2000-01-05T00:00:00', 'advance after publication');
  assert.throws(() => x.run({ ZIT_CHECKPOINT: newer }), /does not match/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
  x.run({ ZIT_CHECKPOINT: x.base });
  assert.deepEqual(x.hashes().slice(0, before.length), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
});

test('invalid saved checkpoint or fork fails without replacing output', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  const saved = x.f(['sqlite3', '-R', x.out, "SELECT value FROM config WHERE name='rfc-projection-v1'"]);
  const invalid = JSON.stringify({ ...JSON.parse(saved), checkin: 'missing' });
  x.f(['sqlite3', '-R', x.out, `UPDATE config SET value='${invalid}' WHERE name='rfc-projection-v1'`]);
  const bytes = fs.readFileSync(x.out);
  assert.throws(() => x.run(), /primary-parent chain/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
  x.f(['sqlite3', '-R', x.out, `UPDATE config SET value='${saved}' WHERE name='rfc-projection-v1'`]);
  x.write('test', 'first child\n');
  x.commit(x.source.work, '2000-01-05T00:00:00', 'first child');
  x.f(['update', x.base], x.source.work);
  x.write('test', 'fork child\n');
  x.commit(x.source.work, '2000-01-06T00:00:00', 'fork child', ['--allow-fork']);
  const beforeFork = fs.readFileSync(x.out);
  assert.throws(() => x.run(), /exactly one open trunk leaf/);
  assert.deepEqual(fs.readFileSync(x.out), beforeFork);
});

test('conflict resolution, deletion, reversion and timestamp ties follow primary ancestry', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  const before = x.hashes();
  x.write('test', 'side text\n');
  x.write('branch', 'accepted branch file\n');
  x.commit(x.source.work, '2000-01-05T00:00:00', 'side changes', ['--branch', 'side']);
  x.f(['update', 'trunk'], x.source.work);
  x.write('test', 'trunk wins\n');
  x.commit(x.source.work, '2000-01-06T00:00:00', 'trunk change');
  x.f(['merge', 'side'], x.source.work);
  x.write('test', 'trunk wins\n');
  x.commit(x.source.work, '2000-01-06T00:00:00', 'resolved integration');
  x.run();
  assert.deepEqual(x.hashes().slice(0, before.length), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
  x.write('test', 'base\n');
  x.f(['rm', '--hard', 'docs/rfcs/draft-fossil-branch-00.txt'], x.source.work);
  x.commit(x.source.work, '2000-01-06T00:00:00', 'restore and remove');
  x.run();
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
});

test('a legacy published chain bootstraps only against an exact source snapshot', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  // Discard only local metadata, simulating the pre-checkpoint publication.
  x.f(['sqlite3', '-R', x.out, "DELETE FROM config WHERE name='rfc-projection-v1'"]);
  const before = x.hashes();
  const bytes = fs.readFileSync(x.out);
  assert.throws(() => x.run(), /Existing output needs ZIT_CHECKPOINT/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
  x.write('test', 'new trunk\n');
  const later = x.commit(x.source.work, '2000-01-05T00:00:00', 'later');
  assert.throws(() => x.run({ ZIT_CHECKPOINT: later }), /does not match/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
  x.run({ ZIT_CHECKPOINT: x.base });
  assert.deepEqual(x.hashes().slice(0, before.length), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
  // The cursor is validated against source data, not trusted as a magic index.
  x.f(['sqlite3', '-R', x.out,
    `UPDATE config SET value=json_set(value,'$.checkin','${x.base}') WHERE name='rfc-projection-v1'`]);
  const corrupt = fs.readFileSync(x.out);
  assert.throws(() => x.run(), /does not match/);
  assert.deepEqual(fs.readFileSync(x.out), corrupt);
});

test('fresh rebuild identities are deterministic and cursors survive Fossil rebuild', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  const before = x.hashes();
  x.f(['rebuild', x.out]);
  x.run();
  assert.deepEqual(x.hashes(), before);
  fs.rmSync(x.out);
  x.run();
  assert.deepEqual(x.hashes(), before);
  assert.equal(x.snapshot(x.out), x.snapshot(x.source.repo, 'docs/rfcs/'));
});

test('ambiguous trunk forks and source-output aliases fail without changing output', { timeout: 120000 }, t => {
  const x = fixture(t);
  x.run();
  x.write('test', 'first fork\n');
  x.commit(x.source.work, '2000-01-05T00:00:00', 'first fork');
  x.f(['update', x.base], x.source.work);
  x.write('test', 'second fork\n');
  x.commit(x.source.work, '2000-01-06T00:00:00', 'second fork', ['--allow-fork']);
  const bytes = fs.readFileSync(x.out);
  assert.throws(() => x.run(), /exactly one open trunk leaf/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
  assert.throws(() => x.run({ OUTPUT_REPO: x.source.repo }), /must not be a source/);
  const alias = path.join(x.root, 'alias.fossil');
  fs.linkSync(x.original.repo, alias);
  assert.throws(() => x.run({ OUTPUT_REPO: alias }), /must not be a source/);
  assert.deepEqual(fs.readFileSync(x.out), bytes);
});
