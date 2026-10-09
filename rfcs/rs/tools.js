// Fossil Repository State: live views of the derived tables, a name resolver,
// and a tag-propagation stepper that follows Sections 5.3 to 5.5.
window.RFC_TOOLS = window.RFC_TOOLS || {};
(function () {
  // Each live table: the section that defines it, the SELECT that shows it,
  // and example rows (a three-revision repository built by Fossil 2.28) shown
  // until this draft's own repository opens.
  const T1 = "2026-07-29 09:00:00", T2 = "2026-07-29 09:40:12", T3 = "2026-07-29 10:15:37", T4 = "2026-07-29 11:02:48";
  const TABLES = {
    tag: {
      sql: "SELECT tagid, tagname FROM tag ORDER BY tagid",
      cols: ["tagid", "tagname"],
      rows: [[1, "bgcolor"], [2, "comment"], [3, "user"], [4, "date"], [5, "hidden"], [6, "private"], [7, "cluster"],
        [8, "branch"], [9, "closed"], [10, "parent"], [11, "note"], [12, "sym-trunk"]],
      note(r) {
        const by = Object.fromEntries(r.map((x) => [String(x[0]), x[1]]));
        return `<span>tagid 8 is <b>${by["8"] || "absent"}</b></span><span>tagid 9 is <b>${by["9"] || "absent"}</b></span><span><b>${r.length}</b> tags</span>`;
      },
    },
    plink: {
      sql: "SELECT p.pid, substr(pb.uuid,1,10) AS parent, p.cid, substr(cb.uuid,1,10) AS child,\n       p.isprim, datetime(p.mtime) AS mtime, p.baseid\nFROM plink p JOIN blob pb ON pb.rid=p.pid JOIN blob cb ON cb.rid=p.cid\nORDER BY p.mtime",
      cols: ["pid", "parent", "cid", "child", "isprim", "mtime", "baseid"],
      rows: [[1, "4013aa3b9e", 3, "9ea90484a2", 1, T2, null], [3, "9ea90484a2", 5, "3d26280e59", 1, T3, null],
        [5, "3d26280e59", 7, "8b83a56d21", 1, T4, null]],
      note(r) {
        const prim = r.filter((x) => Number(x[4]) === 1).length;
        return `<span><b>${r.length}</b> linkage rows</span><span><b>${prim}</b> primary</span><span><b>${r.length - prim}</b> merge</span>`;
      },
    },
    tagxref: {
      sql: "SELECT x.rid, t.tagname, x.tagtype, x.srcid, x.origid, x.value, datetime(x.mtime) AS mtime\nFROM tagxref x JOIN tag t ON t.tagid=x.tagid\nORDER BY x.rid, t.tagname",
      cols: ["rid", "tagname", "tagtype", "srcid", "origid", "value", "mtime"],
      rows: [[1, "branch", 2, 1, 1, "trunk", T1], [1, "sym-trunk", 2, 1, 1, null, T1],
        [3, "branch", 2, 0, 1, "trunk", T1], [3, "sym-trunk", 2, 0, 1, null, T1],
        [5, "branch", 2, 0, 1, "trunk", T1], [5, "sym-trunk", 2, 0, 1, null, T1],
        [7, "branch", 2, 0, 1, "trunk", T1], [7, "sym-trunk", 2, 0, 1, null, T1]],
      note(r) {
        const direct = r.filter((x) => Number(x[3]) !== 0).length;
        return `<span><b>${direct}</b> direct rows (srcid ≠ 0)</span><span><b>${r.length - direct}</b> propagated rows (srcid 0)</span>`;
      },
    },
    branch: {
      sql: "SELECT x.value AS branch, datetime(max(e.mtime)) AS latest, count(*) AS checkins\nFROM tagxref x JOIN tag t ON t.tagid=x.tagid JOIN event e ON e.objid=x.rid\nWHERE t.tagname='branch' AND x.tagtype>0\nGROUP BY x.value ORDER BY max(e.mtime) DESC",
      cols: ["branch", "latest", "checkins"],
      rows: [["trunk", T4, 4]],
      note(r) { return `<span><b>${r.length}</b> branch${r.length === 1 ? "" : "es"}, derived from tagxref</span>`; },
    },
    leaf: {
      sql: "SELECT l.rid, substr(b.uuid,1,10) AS hash,\n  (SELECT x.value FROM tagxref x JOIN tag t ON t.tagid=x.tagid\n    WHERE x.rid=l.rid AND t.tagname='branch' AND x.tagtype>0) AS branch,\n  EXISTS(SELECT 1 FROM tagxref x JOIN tag t ON t.tagid=x.tagid\n    WHERE x.rid=l.rid AND t.tagname='closed' AND x.tagtype>0) AS closed\nFROM leaf l JOIN blob b ON b.rid=l.rid",
      cols: ["rid", "hash", "branch", "closed"],
      rows: [[7, "8b83a56d21", "trunk", 0]],
      note(r) {
        const closed = r.filter((x) => Number(x[3]) !== 0).length;
        return `<span><b>${r.length}</b> leaves</span><span><b>${r.length - closed}</b> open</span><span><b>${closed}</b> closed</span>`;
      },
    },
  };

  const MAX_ROWS = 12;
  let ROOT = null, API = null, RESOLVE = null;

  function table(ctx, cols, rows) {
    const wrap = ctx.el("div", "tbl-wrap");
    const t = ctx.el("table");
    const hr = ctx.el("tr");
    cols.forEach((c) => hr.append(ctx.el("th", null, c)));
    t.append(ctx.el("thead")); t.tHead.append(hr);
    const tb = ctx.el("tbody");
    rows.slice(0, MAX_ROWS).forEach((r) => {
      const tr = ctx.el("tr");
      r.forEach((v) => tr.append(ctx.el("td", typeof v === "number" ? "num" : null, v == null ? "null" : String(v))));
      tb.append(tr);
    });
    t.append(tb); wrap.append(t);
    return wrap;
  }

  function renderTable(ctx, box, spec, cols, rows, live) {
    box.textContent = "";
    const h = ctx.el("div", "tool-h");
    h.append(ctx.el("b", null, box.dataset.title));
    const st = ctx.el("span", live ? "status ok" : null, live ? "live · this repository" : "Example rows. This draft's repository replaces them when it opens.");
    h.append(st);
    box.append(h, ctx.el("div", "readout", spec.sql), table(ctx, cols, rows));
    const s = ctx.el("div", "stats");
    s.innerHTML = spec.note(rows) + (rows.length > MAX_ROWS ? `<span>first ${MAX_ROWS} of ${rows.length} shown</span>` : "");
    box.append(s);
  }

  function sq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

  // Section 8.2: candidates are check-ins with an active sym-N tag, chosen by
  // the greatest event.mtime. Section 9: open leaves need an active branch tag
  // of value N, leaf-table membership and no active closed tag.
  function resolveSql(name) {
    return {
      cand: "SELECT e.objid AS rid, substr(b.uuid,1,10) AS hash, datetime(e.mtime) AS mtime,\n" +
        "  EXISTS(SELECT 1 FROM leaf l WHERE l.rid=e.objid) AS leaf,\n" +
        "  EXISTS(SELECT 1 FROM tagxref c JOIN tag ct ON ct.tagid=c.tagid\n" +
        "    WHERE c.rid=e.objid AND ct.tagname='closed' AND c.tagtype>0) AS closed\n" +
        "FROM tagxref x JOIN tag t ON t.tagid=x.tagid\n" +
        "  JOIN event e ON e.objid=x.rid JOIN blob b ON b.rid=e.objid\n" +
        "WHERE t.tagname=" + sq("sym-" + name) + " AND x.tagtype>0\nORDER BY e.mtime DESC",
      open: "SELECT l.rid, substr(b.uuid,1,10) AS hash, datetime(e.mtime) AS mtime\n" +
        "FROM leaf l JOIN tagxref x ON x.rid=l.rid AND x.tagtype>0 AND x.value=" + sq(name) + "\n" +
        "  JOIN tag t ON t.tagid=x.tagid AND t.tagname='branch'\n" +
        "  JOIN event e ON e.objid=l.rid JOIN blob b ON b.rid=l.rid\n" +
        "WHERE NOT EXISTS(SELECT 1 FROM tagxref c JOIN tag ct ON ct.tagid=c.tagid\n" +
        "  WHERE c.rid=l.rid AND ct.tagname='closed' AND c.tagtype>0)\nORDER BY e.mtime DESC",
    };
  }

  // The Section 10.2 state, shown until the repository opens.
  const EXAMPLE_RESOLVE = {
    cand: [["—", "ee3a7eed71", "newest", 1, 1], ["—", "b05cbea82b", "older", 1, 0], ["—", "fork point", "oldest", 0, 0]],
    open: [["—", "b05cbea82b", "older"]],
  };

  function renderResolve(ctx, root, api) {
    const box = ctx.$("#rs-resolve", root);
    ctx.$$("[data-gen]", box).forEach((n) => n.remove());
    const add = (n) => { n.dataset.gen = "1"; box.append(n); return n; };
    const name = ctx.$("#rs-resolve-name", root).value.trim() || "trunk";
    let cand, open, live = !!api, extra = "";
    if (api) {
      const q = resolveSql(name);
      try {
        cand = ctx.P(api.query(q.cand)).rows;
        open = ctx.P(api.query(q.open)).rows;
        const tip = ctx.P(api.query("SELECT substr(b.uuid,1,10) FROM event e JOIN blob b ON b.rid=e.objid WHERE e.type='ci' ORDER BY e.mtime DESC LIMIT 1")).rows;
        extra += `<span><b>tip</b> is ${tip.length ? tip[0][0] : "nothing"}</span>`;
        try {
          const mb = ctx.P(api.query("SELECT value FROM config WHERE name='main-branch'")).rows;
          extra += `<span>main-branch is ${mb.length && mb[0][0] ? "<b>" + String(mb[0][0]).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) + "</b>" : "unset, so <b>trunk</b>"}</span>`;
        } catch (e) { /* config may be unreadable; the rest still stands */ }
      } catch (e) {
        add(ctx.el("div", "readout", "Query failed: " + e.message));
        return;
      }
    } else {
      cand = name === "trunk" ? EXAMPLE_RESOLVE.cand : [];
      open = name === "trunk" ? EXAMPLE_RESOLVE.open : [];
    }
    const st = ctx.$("#rs-resolve-status", root);
    st.className = live ? "status ok" : "";
    st.textContent = live ? "live · this repository" : "Example: the §10.2 state. This draft's repository replaces it when it opens.";
    add(ctx.el("div", "readout", cand.length
      ? `${name} → ${cand[0][1]}${Number(cand[0][4]) ? " (closed)" : ""}${Number(cand[0][3]) ? "" : " (not a leaf)"}`
      : `${name} → no check-in carries an active sym-${name} tag, so the plain-name rule fails`));
    const sub = (t) => { const h = add(ctx.el("div", "tool-h")); h.append(ctx.el("b", null, t)); };
    sub(`Candidates: active sym-${name}, newest first (§8.2)`);
    add(table(ctx, ["rid", "hash", "mtime", "leaf", "closed"], cand));
    sub(`Open leaves of branch ${name} (§9)`);
    add(open.length ? table(ctx, ["rid", "hash", "mtime"], open) : ctx.el("div", "readout", "None, so the branch is reported as not open."));
    const s = add(ctx.el("div", "stats"));
    const same = cand.length && open.length && cand[0][1] === open[0][1];
    s.innerHTML = `<span><b>${cand.length}</b> candidates</span><span><b>${open.length}</b> open leaves</span><span>` +
      (cand.length && open.length ? (same ? "both questions name the same check-in" : "<b>the two answers differ</b>") : "nothing to compare") + "</span>" + extra;
  }

  // Section 5.3 and 5.4 on a five-check-in primary chain c1..c5.
  const CHAIN = ["c1", "c2", "c3", "c4", "c5"];
  function freshState() {
    const rows = {};
    CHAIN.forEach((c, i) => { rows[c] = { tagtype: 2, srcid: i === 0 ? "c1" : 0, origid: "c1", value: "alpha", mtime: 10 }; });
    return rows;
  }

  function applyTag(state, target, type, value, mtime) {
    const log = {};
    const cur = state[target];
    if (cur && cur.mtime >= mtime) {
      log[target] = `skipped: existing mtime ${cur.mtime} ≥ ${mtime} (§5.3 step 1)`;
      return log;
    }
    state[target] = { tagtype: type, srcid: "tag artifact", origid: target, value: type === 0 ? null : value, mtime };
    log[target] = type === 0 ? "direct cancel, value cleared (§5.3 steps 2–3)" : `direct ${type === 1 ? "singleton" : "propagating"} tag (§5.3 step 2)`;
    const ptype = type === 1 ? 0 : type; // §5.3 step 4: a singleton propagates as a cancel
    const queue = [target];
    while (queue.length) {
      const at = queue.shift();
      const i = CHAIN.indexOf(at);
      if (i + 1 >= CHAIN.length) continue;
      const child = CHAIN[i + 1];
      const row = state[child];
      let doit;
      if (!row) {
        doit = ptype === 2;
        if (!doit) log[child] = "no row to delete, the cancel stops (§5.4 step 3)";
      } else if (row.srcid !== 0) {
        doit = false; log[child] = "blocked: direct row, srcid ≠ 0 (§5.5)";
      } else if (row.mtime >= mtime) {
        doit = false; log[child] = `blocked: inherited row mtime ${row.mtime} ≥ ${mtime} (§5.4 step 3)`;
      } else doit = true;
      if (!doit) continue;
      if (ptype === 2) {
        state[child] = { tagtype: 2, srcid: 0, origid: target, value, mtime };
        log[child] = `propagated from ${target} (§5.4 step 4)`;
      } else {
        delete state[child];
        log[child] = `row deleted by ${type === 1 ? "the downgraded singleton" : "the cancel"} (§5.4 step 4)`;
      }
      queue.push(child);
    }
    return log;
  }

  function renderSim(ctx, root, sim) {
    CHAIN.forEach((c) => { ctx.$("#rs-sim-t-" + c, root).className = c === sim.target ? "btn primary" : "btn"; });
    ["2", "1", "0"].forEach((t) => { ctx.$("#rs-sim-y-" + t, root).className = Number(t) === sim.type ? "btn primary" : "btn"; });
    const body = ctx.$("#rs-sim-rows", root);
    body.textContent = "";
    CHAIN.forEach((c) => {
      const r = sim.state[c];
      const tr = ctx.el("tr");
      tr.append(ctx.el("td", "num", c));
      if (r) {
        [r.tagtype, r.srcid, r.origid, r.value == null ? "null" : r.value, r.mtime].forEach((v) => tr.append(ctx.el("td", typeof v === "number" ? "num" : null, String(v))));
      } else {
        tr.append(ctx.el("td", null, "no row"));
        for (let k = 0; k < 4; k++) tr.append(ctx.el("td"));
      }
      tr.append(ctx.el("td", null, sim.log[c] || ""));
      body.append(tr);
    });
    ctx.$("#rs-sim-mtime", root).value = sim.mtime;
  }

  window.RFC_TOOLS["rs"] = {
    init(root, ctx) {
      ROOT = root;
      ctx.$$("[data-rs-table]", root).forEach((box) => {
        const spec = TABLES[box.dataset.rsTable];
        renderTable(ctx, box, spec, spec.cols, spec.rows, false);
      });

      const nameIn = ctx.$("#rs-resolve-name", root);
      if (nameIn) {
        RESOLVE = () => renderResolve(ctx, root, API);
        nameIn.addEventListener("input", RESOLVE);
        RESOLVE();
      }

      if (ctx.$("#rs-sim-rows", root)) {
        const START = { c1: "direct, from c1's own T card", c2: "inherited from c1", c3: "inherited from c1", c4: "inherited from c1", c5: "inherited from c1" };
        const sim = { state: freshState(), log: START, target: "c3", type: 2, mtime: 20 };
        CHAIN.forEach((c) => ctx.$("#rs-sim-t-" + c, root).addEventListener("click", () => { sim.target = c; renderSim(ctx, root, sim); }));
        ["2", "1", "0"].forEach((t) => ctx.$("#rs-sim-y-" + t, root).addEventListener("click", () => { sim.type = Number(t); renderSim(ctx, root, sim); }));
        ctx.$("#rs-sim-mtime", root).addEventListener("change", (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) sim.mtime = v; });
        ctx.$("#rs-sim-apply", root).addEventListener("click", () => {
          const v = Number(ctx.$("#rs-sim-mtime", root).value);
          if (Number.isFinite(v)) sim.mtime = v;
          const value = ctx.$("#rs-sim-value", root).value.trim() || "beta";
          sim.log = applyTag(sim.state, sim.target, sim.type, value, sim.mtime);
          sim.mtime += 10;
          renderSim(ctx, root, sim);
        });
        ctx.$("#rs-sim-reset", root).addEventListener("click", () => {
          sim.state = freshState(); sim.log = START; sim.mtime = 20; renderSim(ctx, root, sim);
        });
        renderSim(ctx, root, sim);
      }
    },

    onRepo(api, ctx) {
      const root = ROOT || document;
      ctx.$$("[data-rs-table]", root).forEach((box) => {
        const spec = TABLES[box.dataset.rsTable];
        try {
          const r = ctx.P(api.query(spec.sql));
          renderTable(ctx, box, spec, r.columns, r.rows, true);
        } catch (e) {
          box.append(ctx.el("div", "readout", "Query failed: " + e.message));
        }
      });
      API = api;
      if (RESOLVE) RESOLVE();
    },
  };
})();
