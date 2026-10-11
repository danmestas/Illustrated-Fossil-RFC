#!/usr/bin/env node
// Build rfcs/repos/rfcs.fossil, the one repository the site serves: every
// Fossil RFC draft and every erratum, with their real history.
//
//   1. The original drafts in ~/fossil-rfc's repository, from before zit took
//      them over: every version of a top-level draft-fossil-*.txt checked in
//      before zit's first draft import.
//   2. zit's history of docs/rfcs/draft-fossil-*.txt and docs/rfcs/erratum/*,
//      which is authoritative from then on.
//
// Each distinct version of a file is committed once, with the date, user and
// comment of the earliest check-in that introduced it; versions introduced by
// the same check-in are committed together. Drafts sit at the repository's
// root and errata under erratum/, as in zit's docs/rfcs/.
//
// The project code is fixed, so a rebuild is the same project: the Worker's
// stored copy merges it in, and existing clones keep pulling from it.
//
// Needs fossil on the PATH, zit's repository and ~/fossil-rfc's.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ZIT = process.env.ZIT_REPO || path.join(HOME, "zit/.zit.fossil");
const ORIGINALS = process.env.ORIGINALS_REPO || path.join(HOME, "fossil-rfc/fossil-rfc.fossil");
const OUT = path.join(import.meta.dirname, "../rfcs/repos/rfcs.fossil");
// SHA-1 of "fossil-rfcs": fixed, so every build is the same project.
const PROJECT_CODE = "14c3ea8917bf2cd0890fb8c73a6a07d3bf74a74b";

const fossil = (args, opts = {}) => execFileSync("fossil", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
// Rows of fields as the SQL shell lists them, separated by "|". Only names,
// hashes, dates and logins go through here, none of which can hold one.
const sql = (repo, query) => fossil(["sqlite3", "-R", repo, query]).split("\n").filter(Boolean).map((l) => l.split("|"));
const value = (repo, query) => fossil(["sqlite3", "-R", repo, query]).replace(/\n$/, "");
const q = (s) => s.replace(/'/g, "''");

// One row per distinct version of a file in scope: the earliest check-in that
// introduced it.
function versions(repo, where, rename, before) {
  return sql(repo, `
    SELECT fn.name, b.uuid, c.uuid, e.mtime, datetime(e.mtime), e.user
    FROM mlink m JOIN filename fn USING(fnid) JOIN blob b ON b.rid=m.fid
      JOIN blob c ON c.rid=m.mid JOIN event e ON e.objid=m.mid
    WHERE m.fid>0 AND (${where}) ${before ? `AND e.mtime < ${before}` : ""}
      AND e.mtime = (SELECT min(e2.mtime) FROM mlink m2 JOIN event e2 ON e2.objid=m2.mid
                     WHERE m2.fid=m.fid AND m2.fnid=m.fnid)
    GROUP BY fn.name, b.uuid`)
    .map(([name, file, checkin, mtime, date, user]) => ({ repo, path: rename(name), file, checkin, mtime: Number(mtime), date, user }));
}

const zitFirst = Number(value(ZIT, "SELECT min(e.mtime) FROM mlink m JOIN filename fn USING(fnid) JOIN event e ON e.objid=m.mid WHERE fn.name GLOB 'docs/rfcs/draft-fossil-*.txt'"));
const all = [
  ...versions(ORIGINALS, "fn.name GLOB 'draft-fossil-*.txt'", (n) => n, zitFirst),
  ...versions(ZIT, "fn.name GLOB 'docs/rfcs/draft-fossil-*.txt' OR fn.name GLOB 'docs/rfcs/erratum/*'", (n) => n.slice("docs/rfcs/".length)),
];

// Group by check-in, oldest first.
const groups = new Map();
for (const v of all.sort((a, b) => a.mtime - b.mtime)) {
  const key = `${v.repo} ${v.checkin}`;
  if (!groups.has(key)) groups.set(key, { ...v, files: [] });
  groups.get(key).files.push(v);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "rfcs-repo-"));
try {
  fs.rmSync(OUT, { force: true });
  const first = [...groups.values()][0];
  fossil(["init", "--date-override", first.date, "-A", "dmestas", "--project-name", "fossil-rfcs",
    "--project-desc", "The Fossil RFC drafts and their errata", OUT]);
  fossil(["sqlite3", "-R", OUT, `UPDATE config SET value='${PROJECT_CODE}' WHERE name='project-code'`]);
  fossil(["open", OUT], { cwd: work });
  fossil(["settings", "autosync", "off"], { cwd: work });
  fossil(["settings", "mtime-changes", "off"], { cwd: work });
  let made = 0;
  for (const g of groups.values()) {
    for (const f of g.files) {
      const dest = path.join(work, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, execFileSync("fossil", ["artifact", f.file, "-R", f.repo], { maxBuffer: 1 << 28 }));
    }
    fossil(["addremove"], { cwd: work });
    if (!fossil(["changes"], { cwd: work }).trim()) continue;
    const comment = value(g.repo, `SELECT coalesce(ecomment, comment) FROM event e JOIN blob c ON c.rid=e.objid WHERE c.uuid='${q(g.checkin)}'`);
    fossil(["commit", "-m", comment, "--date-override", g.date, "--user-override", g.user, "--no-warnings"], { cwd: work });
    made++;
    console.log(`${g.date}  ${g.user.padEnd(10)}  ${g.files.map((f) => f.path).join(", ")}`);
  }
  fossil(["close", "--force"], { cwd: work });
  // The repository is published and served, so no account may log in to it:
  // clear every password and capability but nobody's. Clearing capabilities
  // as well as passwords means an implementation that admitted an empty
  // password would still grant nothing.
  fossil(["sqlite3", "-R", OUT, "UPDATE user SET pw='', cap='' WHERE login<>'nobody'; VACUUM;"]);
  console.log(`${made} check-ins; ${fossil(["test-integrity", "-R", OUT]).trim().split("\n").pop()}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
