#!/usr/bin/env node
// Append authoritative trunk snapshots to the RFC repository. Existing check-in
// artifacts are retained verbatim; a fixed project code alone cannot do that.
// Merged work enters at its trunk integration, with trunk's resolved contents.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ZIT = path.resolve(process.env.ZIT_REPO || path.join(HOME, 'zit/.zit.fossil'));
const ORIGINALS = path.resolve(process.env.ORIGINALS_REPO || path.join(HOME, 'fossil-rfc/fossil-rfc.fossil'));
// An explicit output keeps maintenance separate from publication. For a published
// repository, operate on a copy and review it before replacing the served file.
if (!process.env.OUTPUT_REPO) throw new Error('OUTPUT_REPO must name a fresh output or a copy of the published repository');
const OUT = path.resolve(process.env.OUTPUT_REPO);
const PROJECT_CODE = '14c3ea8917bf2cd0890fb8c73a6a07d3bf74a74b';
const CURSOR = 'rfc-projection-v1';
const q = s => String(s).replace(/'/g, "''");
const fossil = (args, opts = {}) => execFileSync('fossil', args, {
  encoding: 'utf8', maxBuffer: 1 << 28, timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'], ...opts,
});
const value = (repo, query) => fossil(['sqlite3', '-R', repo, query]).replace(/\n$/, '');
const rows = (repo, query) => JSON.parse(value(repo,
  `SELECT coalesce(json_group_array(json(row)), '[]') FROM (${query})`));
const artifact = (repo, hash) => fossil(['artifact', hash, '-R', repo], { encoding: null });
const project = repo => value(repo, "SELECT value FROM config WHERE name='project-code'");

// Refuse symlink/hardlink aliases as well as identical path spellings.
for (const input of [ZIT, ORIGINALS]) {
  if (OUT === input || (fs.existsSync(OUT) && fs.statSync(OUT).dev === fs.statSync(input).dev &&
      fs.statSync(OUT).ino === fs.statSync(input).ino)) throw new Error('Output must not be a source repository');
}

function tip(repo) {
  const leaves = rows(repo, `SELECT json_array(b.uuid) AS row FROM leaf l
    JOIN blob b ON b.rid=l.rid JOIN tagxref x ON x.rid=l.rid JOIN tag t USING(tagid)
    WHERE t.tagname='branch' AND x.value='trunk' AND x.tagtype>0
      AND NOT EXISTS (SELECT 1 FROM tagxref z JOIN tag tz USING(tagid)
        WHERE z.rid=l.rid AND tz.tagname='closed' AND z.tagtype>0)`);
  if (leaves.length !== 1) throw new Error('Expected exactly one open trunk leaf');
  return leaves[0][0];
}

// Primary-parent order remains stable under clock skew and equal timestamps.
const sourceTip = tip(ZIT);
const chain = rows(ZIT, `WITH RECURSIVE history(rid, depth) AS (
  SELECT rid, 0 FROM blob WHERE uuid='${q(sourceTip)}'
  UNION ALL SELECT p.pid, h.depth+1 FROM plink p JOIN history h ON p.cid=h.rid WHERE p.isprim=1)
  SELECT json_array(b.uuid, datetime(e.mtime), coalesce(e.euser,e.user), coalesce(e.ecomment,e.comment)) AS row
  FROM history h JOIN blob b ON b.rid=h.rid JOIN event e ON e.objid=h.rid ORDER BY h.depth DESC`);

function snapshot(repo, checkin, prefix = '') {
  const files = rows(repo, `SELECT json_array(filename, uuid) AS row
    FROM files_of_checkin('${q(checkin)}') ORDER BY filename`);
  return new Map(files.filter(([name]) => !prefix ||
    (name.startsWith(prefix) && (/^draft-fossil-.*-00\.txt$/.test(name.slice(prefix.length)) ||
      name.startsWith(`${prefix}erratum/`))))
    .map(([name, hash]) => [name.slice(prefix.length), hash]));
}
const sourceSnapshot = checkin => snapshot(ZIT, checkin, 'docs/rfcs/');
function contents(repo, files) {
  return new Map([...files].map(([name, hash]) => {
    if (path.isAbsolute(name) || name.split('/').some(p => p === '..' || p === '.' || !p) || name.includes('\\')) {
      throw new Error('Unsafe projected filename');
    }
    return [name, artifact(repo, hash)];
  }));
}
function fingerprint(files) {
  return JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const stage = fs.mkdtempSync(path.join(path.dirname(OUT), '.rfc-projection-'));
const staged = path.join(stage, 'repository.fossil');
const work = path.join(stage, 'checkout');
fs.mkdirSync(work);
let opened = false;
try {
  let start = 0;
  let current = new Map();
  if (fs.existsSync(OUT)) {
    // SQLite's backup API includes committed WAL contents; a file copy does not.
    fossil(['sqlite3', '-R', OUT, `.backup '${q(staged)}'`]);
    if (project(staged) !== PROJECT_CODE) throw new Error('Unexpected output project identity');
    const saved = value(staged, `SELECT value FROM config WHERE name='${CURSOR}'`);
    const checkpoint = saved ? JSON.parse(saved) : { source: project(ZIT), checkin: process.env.ZIT_CHECKPOINT };
    if (!checkpoint.checkin) throw new Error('Existing output needs ZIT_CHECKPOINT: the source check-in matching its tip');
    if (checkpoint.source !== project(ZIT)) throw new Error('Checkpoint source project identity mismatch');
    const index = chain.findIndex(([hash]) => hash === checkpoint.checkin);
    if (index < 0) throw new Error('Checkpoint is not on the current trunk primary-parent chain');
    current = contents(staged, snapshot(staged, tip(staged)));
    if (fingerprint(current) !== fingerprint(contents(ZIT, sourceSnapshot(checkpoint.checkin)))) {
      throw new Error('Output tip does not match the source checkpoint snapshot');
    }
    start = index + 1;
  } else {
    fossil(['init', '--date-override', chain[0][1], '-A', 'dmestas', '--project-name', 'fossil-rfcs',
      '--project-desc', 'The Fossil RFC drafts and their errata', staged]);
    fossil(['sqlite3', '-R', staged, `UPDATE config SET value='${PROJECT_CODE}' WHERE name='project-code'`]);
  }
  fossil(['open', staged, tip(staged)], { cwd: work });
  opened = true;
  fossil(['settings', 'autosync', 'off'], { cwd: work });
  fossil(['settings', 'mtime-changes', 'off'], { cwd: work });
  let made = 0;
  function apply(next, [hash, date, user, comment]) {
    if (fingerprint(next) === fingerprint(current)) return;
    for (const name of current.keys()) if (!next.has(name)) {
      const removed = path.join(work, name);
      fs.rmSync(removed, { force: true });
      // A tracked directory can become a file. Prune only empty ancestors of
      // removed files; never recursively remove a surviving file or the checkout.
      for (let dir = path.dirname(removed); dir !== work; dir = path.dirname(dir)) {
        try { fs.rmdirSync(dir); } catch (error) {
          if (error.code === 'ENOTEMPTY' || error.code === 'ENOENT') break;
          throw error;
        }
      }
    }
    for (const [name, bytes] of next) {
      const dest = path.join(work, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    }
    fossil(['addremove', '--dotfiles', '--ignore', '', '--clean', ''], { cwd: work });
    // The acting user belongs to the staged repository, not the host OS.
    // The historical author remains independent through --user-override.
    fossil(['commit', '--user', 'dmestas', '-m', comment || 'RFC snapshot', '--date-override', date, '--user-override', user,
      '--allow-older', '--no-warnings'], { cwd: work });
    current = next;
    made++;
    console.log(`${date}  ${hash}`);
  }
  if (!fs.existsSync(OUT)) {
    // The original archive is a one-time import, never reconsidered on append.
    const first = value(ZIT, `SELECT min(e.mtime) FROM mlink m JOIN filename fn USING(fnid)
      JOIN event e ON e.objid=m.mid WHERE fn.name GLOB 'docs/rfcs/draft-fossil-*.txt'`);
    if (!first) throw new Error('Source has no draft import');
    // Do not replay pre-import empty snapshots over the original archive.
    start = chain.findIndex(([hash]) => sourceSnapshot(hash).size > 0);
    if (start < 0) throw new Error('Trunk has no projected draft history');
    const versions = rows(ORIGINALS, `SELECT json_array(fn.name,b.uuid,c.uuid,datetime(e.mtime),
        coalesce(e.euser,e.user),coalesce(e.ecomment,e.comment)) AS row
      FROM mlink m JOIN filename fn USING(fnid) JOIN blob b ON b.rid=m.fid
        JOIN blob c ON c.rid=m.mid JOIN event e ON e.objid=m.mid
      WHERE fn.name GLOB 'draft-fossil-*.txt' AND m.fid>0 AND e.mtime < ${Number(first)}
      ORDER BY e.mtime,c.uuid,fn.name`);
    const groups = new Map();
    const seen = new Set();
    for (const [name, file, hash, date, user, comment] of versions) {
      const key = `${name}:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(hash)) groups.set(hash, { metadata: [hash, date, user, comment], files: [] });
      groups.get(hash).files.push([name, file]);
    }
    for (const { metadata, files } of groups.values()) apply(new Map([...current, ...contents(ORIGINALS, new Map(files))]), metadata);
  }
  for (const entry of chain.slice(start)) apply(contents(ZIT, sourceSnapshot(entry[0])), entry);
  if (fingerprint(contents(staged, snapshot(staged, tip(staged)))) !==
      fingerprint(contents(ZIT, sourceSnapshot(sourceTip)))) {
    throw new Error('Generated tip does not match the authoritative trunk snapshot');
  }
  fossil(['close', '--force'], { cwd: work });
  opened = false;
  // The checkpoint is local/rebuildable metadata, not an invented check-in. A
  // lost checkpoint can be re-established only by exact snapshot validation.
  const checkpoint = JSON.stringify({ source: project(ZIT), checkin: sourceTip });
  // Repack after clearing credentials so old password bytes cannot remain in
  // freed pages of the database that will be served.
  fossil(['sqlite3', '-R', staged, `REPLACE INTO config(name,value,mtime)
    VALUES('${CURSOR}','${q(checkpoint)}',unixepoch());
    UPDATE user SET pw='',cap='' WHERE login<>'nobody';
    VACUUM;`]);
  const integrity = fossil(['test-integrity', '-R', staged]).trim();
  fs.renameSync(staged, OUT);
  console.log(`${made} appended check-ins; ${integrity.split('\n').pop()}`);
} finally {
  if (opened) {
    try { fossil(['close', '--force'], { cwd: work }); } catch { /* disposable checkout */ }
  }
  fs.rmSync(stage, { recursive: true, force: true });
}
