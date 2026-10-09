//go:build js

// Command rfcrepo exposes a read-only Fossil repository to a web page.
// The page fetches the .fossil file, passes its bytes to fossil.open, and
// calls the functions below; each returns a JSON string. The repository is
// loaded into SQLite's in-memory VFS, so no network, Worker or OPFS is needed.
package main

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha3"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"syscall/js"
	"time"
	"unicode/utf8"

	libfossil "github.com/danmestas/go-libfossil"
	"github.com/danmestas/go-libfossil/db"
	"github.com/danmestas/go-libfossil/internal/content"
	fsltype "github.com/danmestas/go-libfossil/internal/fsltype"
	fslverify "github.com/danmestas/go-libfossil/internal/verify"
	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/ext/serdes"
	"github.com/ncruces/go-sqlite3/vfs/memdb"
)

// Several repositories can be open at once, one per name; calls act on the
// one chosen with use(). memdb registers a name without the slash; SQLite
// opens it as "/name".
var repos = map[string]*libfossil.Repo{}

func init() {
	db.Register(db.DriverConfig{
		Name: "sqlite3",
		BuildDSN: func(path string, pragmas map[string]string) string {
			// The in-memory VFS keeps no journal files; a memory journal suffices.
			var parts []string
			keys := make([]string, 0, len(pragmas))
			for k := range pragmas {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				v := pragmas[k]
				if k == "journal_mode" {
					v = "MEMORY"
				}
				parts = append(parts, fmt.Sprintf("_pragma=%s(%s)", k, v))
			}
			return "file:" + path + "?vfs=memdb&" + strings.Join(parts, "&")
		},
	})
}

var repo *libfossil.Repo

type result map[string]any

func reply(v any, err error) any {
	if err != nil {
		b, _ := json.Marshal(result{"error": err.Error()})
		return string(b)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func fn(f func(args []js.Value) (any, error)) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer func() {
			if p := recover(); p != nil {
				fmt.Println("rfcrepo: panic:", p)
			}
		}()
		return reply(f(args))
	})
}

func needRepo() error {
	if repo == nil {
		return fmt.Errorf("repository not open")
	}
	return nil
}

func open(args []js.Value) (any, error) {
	if len(args) != 2 {
		return nil, fmt.Errorf("open takes a name and the repository bytes")
	}
	name := args[0].String()
	data := make([]byte, args[1].Get("length").Int())
	js.CopyBytesToGo(data, args[1])
	memName := name + ".fossil"
	if old, ok := repos[name]; ok {
		old.Close()
		memdb.Delete(memName)
	}
	memdb.Create(memName, data)
	r, err := libfossil.Open("/" + memName)
	if err != nil {
		return nil, err
	}
	repos[name] = r
	repo = r
	projectName, _ := r.Config("project-name")
	code, _ := r.Config("project-code")
	return result{"projectName": projectName, "projectCode": code}, nil
}

type event struct {
	UUID    string   `json:"uuid"`
	RID     int64    `json:"rid"`
	Comment string   `json:"comment"`
	User    string   `json:"user"`
	Time    string   `json:"time"`
	Parents []string `json:"parents"`
}

func timeline(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	entries, err := repo.Timeline(libfossil.TimelineOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]event, 0, len(entries))
	for _, e := range entries {
		parents := e.Parents
		if parents == nil {
			parents = []string{}
		}
		out = append(out, event{e.UUID, e.RID, e.Comment, e.User, e.Time.UTC().Format(time.RFC3339), parents})
	}
	return out, nil
}

func files(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	rid, err := repo.ResolveVersion(args[0].String())
	if err != nil {
		return nil, err
	}
	return repo.ListFiles(rid)
}

func read(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	b, err := repo.ReadFileAt(args[0].String(), args[1].String())
	if err != nil {
		return nil, err
	}
	return result{"text": string(b)}, nil
}

type annotated struct {
	UUID string `json:"uuid"`
	User string `json:"user"`
	Date string `json:"date"`
	Text string `json:"text"`
}

func annotate(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	rid, err := repo.ResolveVersion(args[1].String())
	if err != nil {
		return nil, err
	}
	lines, err := repo.Annotate(libfossil.AnnotateOpts{FilePath: args[0].String(), StartRID: rid})
	if err != nil {
		return nil, err
	}
	out := make([]annotated, 0, len(lines))
	for _, l := range lines {
		out = append(out, annotated{l.UUID, l.User, l.Date.UTC().Format(time.RFC3339), l.Text})
	}
	return out, nil
}

func diff(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	a, err := repo.ResolveVersion(args[0].String())
	if err != nil {
		return nil, err
	}
	b, err := repo.ResolveVersion(args[1].String())
	if err != nil {
		return nil, err
	}
	entries, err := repo.Diff(a, b, args[2].String())
	if err != nil {
		return nil, err
	}
	var sb strings.Builder
	for _, e := range entries {
		sb.WriteString(e.Unified)
	}
	return result{"unified": sb.String()}, nil
}

func artifact(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	var rid int64
	if err := repo.DB().QueryRow("SELECT rid FROM blob WHERE uuid LIKE ? || '%'", strings.ToLower(args[0].String())).Scan(&rid); err != nil {
		return nil, fmt.Errorf("no artifact %q", args[0].String())
	}
	b, err := content.Expand(repo.DB(), fsltype.FslID(rid))
	if err != nil {
		return nil, err
	}
	return result{"text": string(b)}, nil
}

type stored struct {
	RID     int64  `json:"rid"`
	UUID    string `json:"uuid"`
	Size    int64  `json:"size"`
	Stored  int    `json:"stored"`
	SrcUUID string `json:"srcUuid,omitempty"`
	Delta   string `json:"delta,omitempty"`
}

// storage lists every blob as stored: zlib-compressed bytes, and for blobs
// kept as a delta, the source they apply to and the raw delta itself.
func storage(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	rows, err := repo.DB().Query(`SELECT b.rid, b.uuid, b.size, b.content, coalesce(s.uuid, '')
		FROM blob b LEFT JOIN delta d ON d.rid = b.rid LEFT JOIN blob s ON s.rid = d.srcid ORDER BY b.rid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []stored
	for rows.Next() {
		var s stored
		var raw []byte
		if err := rows.Scan(&s.RID, &s.UUID, &s.Size, &raw, &s.SrcUUID); err != nil {
			return nil, err
		}
		s.Stored = len(raw)
		if s.SrcUUID != "" && len(raw) > 4 {
			zr, err := zlib.NewReader(bytes.NewReader(raw[4:]))
			if err == nil {
				d, err := io.ReadAll(zr)
				if err == nil {
					s.Delta = base64.StdEncoding.EncodeToString(d)
				}
			}
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// commit checks in new content for one file on top of the trunk tip, then
// stores the file's previous version as a delta against the new one, as
// `fossil commit` does, so the repository grows by roughly one change.
func commit(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	path, text, comment, user := args[0].String(), args[1].String(), args[2].String(), args[3].String()
	if strings.TrimSpace(comment) == "" || strings.TrimSpace(user) == "" {
		return nil, fmt.Errorf("a check-in needs a comment and a user")
	}
	tip, err := repo.BranchTip("trunk")
	if err != nil {
		return nil, err
	}
	if cur, err := repo.ReadFile(tip, path); err == nil && string(cur) == text {
		return nil, fmt.Errorf("nothing changed: the text matches the current tip")
	}
	var oldRid int64
	_ = repo.DB().QueryRow(`SELECT b.rid FROM mlink m JOIN filename f ON f.fnid = m.fnid
		JOIN blob b ON b.rid = m.fid WHERE m.mid = ? AND f.name = ?`, tip, path).Scan(&oldRid)
	if oldRid == 0 {
		var fileUUID string
		for _, fe := range mustFiles(tip) {
			if fe.Name == path {
				fileUUID = fe.UUID
			}
		}
		_ = repo.DB().QueryRow("SELECT rid FROM blob WHERE uuid = ?", fileUUID).Scan(&oldRid)
	}
	rid, uuid, err := repo.Commit(libfossil.CommitOpts{
		Files:    []libfossil.FileToCommit{{Name: path, Content: []byte(text)}},
		Comment:  comment,
		User:     user,
		Time:     time.Now().UTC(),
		ParentID: tip,
	})
	if err != nil {
		return nil, err
	}
	var newRid int64
	_ = repo.DB().QueryRow(`SELECT m.fid FROM mlink m JOIN filename f ON f.fnid = m.fnid WHERE m.mid = ? AND f.name = ?`, rid, path).Scan(&newRid)
	saved := 0
	if oldRid > 0 && newRid > 0 && oldRid != newRid {
		if err := repo.WithTx(func(tx *db.Tx) error {
			n, err := content.Deltify(tx, fsltype.FslID(oldRid), fsltype.FslID(newRid))
			saved = n
			return err
		}); err != nil {
			return nil, fmt.Errorf("deltify: %w", err)
		}
	}
	return result{"uuid": uuid, "rid": rid, "saved": saved}, nil
}

func mustFiles(rid int64) []libfossil.FileEntry {
	fs, _ := repo.ListFiles(rid)
	return fs
}

// export serializes the whole repository, base64-encoded for a text file.
func export(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	out, err := serialize(repo)
	if err != nil {
		return nil, err
	}
	return result{"base64": base64.StdEncoding.EncodeToString(out), "size": len(out)}, nil
}

// serialize returns the repository's whole SQLite database as bytes.
func serialize(r *libfossil.Repo) ([]byte, error) {
	ctx := context.Background()
	conn, err := r.DB().SqlDB().Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	var out []byte
	err = conn.Raw(func(dc any) error {
		c, ok := dc.(interface{ Raw() *sqlite3.Conn })
		if !ok {
			return fmt.Errorf("driver connection has no raw SQLite handle")
		}
		b, err := serdes.Serialize(c.Raw(), "main")
		out = b
		return err
	})
	return out, err
}

func use(args []js.Value) (any, error) {
	r, ok := repos[args[0].String()]
	if !ok {
		return nil, fmt.Errorf("no repository named %q is open", args[0].String())
	}
	repo = r
	return result{"ok": true}, nil
}

// query runs one read-only SELECT against the open repository's tables.
func query(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	q := strings.TrimSpace(args[0].String())
	q = strings.TrimSuffix(q, ";")
	head := strings.ToUpper(strings.Fields(q + " x")[0])
	if (head != "SELECT" && head != "WITH") || strings.Contains(q, ";") {
		return nil, fmt.Errorf("only a single SELECT statement is allowed")
	}
	rows, err := repo.DB().Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := [][]any{}
	for rows.Next() && len(out) < 500 {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				if utf8.Valid(b) && len(b) <= 2000 && !bytes.ContainsRune(b, 0) {
					vals[i] = string(b)
				} else {
					vals[i] = fmt.Sprintf("<%d bytes>", len(b))
				}
			}
		}
		out = append(out, vals)
	}
	return result{"columns": cols, "rows": out}, rows.Err()
}

type round struct {
	N        int    `json:"n"`
	Request  string `json:"request"`
	Response string `json:"response"`
	ReqBytes int    `json:"reqBytes"`
	ResBytes int    `json:"resBytes"`
}

// decodeXfer turns one sync message into readable card text: the §4.1
// container is a 4-byte length then zlib; file payloads are elided.
func decodeXfer(b []byte) string {
	text := b
	if len(b) > 4 {
		if zr, err := zlib.NewReader(bytes.NewReader(b[4:])); err == nil {
			if d, err := io.ReadAll(zr); err == nil {
				text = d
			}
		}
	}
	var sb strings.Builder
	for len(text) > 0 {
		nl := bytes.IndexByte(text, '\n')
		line := text
		if nl >= 0 {
			line = text[:nl]
			text = text[nl+1:]
		} else {
			text = nil
		}
		sb.Write(line)
		sb.WriteByte('\n')
		f := strings.Fields(string(line))
		if len(f) >= 3 && (f[0] == "file" || f[0] == "cfile" || f[0] == "uvfile") {
			var n int
			if _, err := fmt.Sscanf(f[len(f)-1], "%d", &n); err == nil && n > 0 && n <= len(text) {
				fmt.Fprintf(&sb, "… %d bytes elided …\n", n)
				text = text[n:]
				if len(text) > 0 && text[0] == '\n' {
					text = text[1:]
				}
			}
		}
		if sb.Len() > 60000 {
			sb.WriteString("… rest of message elided …\n")
			break
		}
	}
	return sb.String()
}

var clones int

// cloneDemo clones the open repository into a new, empty in-memory one,
// recording every round of the exchange, then discards the clone.
func cloneDemo(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	src := repo
	ctx := context.Background()
	var rounds []round
	t := libfossil.TransportFunc(func(ctx context.Context, payload []byte) ([]byte, error) {
		resp, err := src.HandleSync(ctx, payload)
		if err != nil {
			return nil, err
		}
		rounds = append(rounds, round{len(rounds) + 1, decodeXfer(payload), decodeXfer(resp), len(payload), len(resp)})
		return resp, nil
	})
	clones++
	name := fmt.Sprintf("clone-%d.fossil", clones)
	cl, res, err := libfossil.Clone(ctx, "/"+name, t, libfossil.CloneOpts{})
	if cl != nil {
		cl.Close()
	}
	memdb.Delete(name)
	if err != nil {
		return result{"error": err.Error(), "rounds": rounds}, nil
	}
	total := 0
	for _, r := range rounds {
		total += r.ReqBytes + r.ResBytes
	}
	return result{"rounds": rounds, "blobs": res.BlobsRecvd, "bytes": total}, nil
}

type held struct {
	UUID string `json:"uuid"`
	Kind string `json:"kind"`
}

// artifactSet lists every artifact a repository holds, in RID order, each
// marked as a check-in manifest or other content.
func artifactSet(r *libfossil.Repo) []held {
	rows, err := r.DB().Query(`SELECT b.uuid, CASE WHEN EXISTS (SELECT 1 FROM event e
		WHERE e.objid = b.rid AND e.type = 'ci') THEN 'check-in' ELSE 'file' END
		FROM blob b WHERE b.size >= 0 ORDER BY b.rid`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []held
	for rows.Next() {
		var h held
		if rows.Scan(&h.UUID, &h.Kind) == nil {
			out = append(out, h)
		}
	}
	return out
}

// demoEdit checks in a one-line change to every file it is given on top of
// the trunk tip, so a sync has something new to move.
func demoEdit(r *libfossil.Repo, user, note string) (string, error) {
	tip, err := r.BranchTip("trunk")
	if err != nil {
		return "", err
	}
	files, err := r.ListFiles(tip)
	if err != nil || len(files) == 0 {
		return "", fmt.Errorf("no files at the tip: %v", err)
	}
	body, err := r.ReadFile(tip, files[0].Name)
	if err != nil {
		return "", err
	}
	body = append(body, []byte("\n   "+note+"\n")...)
	_, uuid, err := r.Commit(libfossil.CommitOpts{
		Files:    []libfossil.FileToCommit{{Name: files[0].Name, Content: body}},
		Comment:  note,
		User:     user,
		Time:     time.Now().UTC(),
		ParentID: tip,
	})
	return uuid, err
}

var demos int

// syncDemo runs a real pull or push between two throwaway in-memory copies of
// the open repository: a "server" copy, and a "client" cloned from it. For a
// pull the server gets a new check-in first; for a push the client does. Every
// round is recorded, with both sides' artifact sets before and after.
func syncDemo(args []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	kind := args[0].String()
	if kind != "pull" && kind != "push" {
		return nil, fmt.Errorf("syncDemo takes \"pull\" or \"push\"")
	}
	ctx := context.Background()
	demos++
	srvName, cliName := fmt.Sprintf("demo-server-%d.fossil", demos), fmt.Sprintf("demo-client-%d.fossil", demos)
	data, err := serialize(repo)
	if err != nil {
		return nil, err
	}
	memdb.Create(srvName, data)
	defer memdb.Delete(srvName)
	defer memdb.Delete(cliName)
	srv, err := libfossil.Open("/" + srvName)
	if err != nil {
		return nil, err
	}
	defer srv.Close()
	if err := srv.CreateUser(libfossil.UserOpts{Login: "editor", Password: "demo", Caps: "oi"}); err != nil {
		return nil, fmt.Errorf("server user: %w", err)
	}
	quiet := libfossil.TransportFunc(func(ctx context.Context, p []byte) ([]byte, error) { return srv.HandleSync(ctx, p) })
	cli, _, err := libfossil.Clone(ctx, "/"+cliName, quiet, libfossil.CloneOpts{})
	if err != nil {
		return nil, fmt.Errorf("clone: %w", err)
	}
	defer cli.Close()

	var made string
	if kind == "pull" {
		made, err = demoEdit(srv, "server", "Edited on the server; a pull brings this check-in to the client.")
	} else {
		made, err = demoEdit(cli, "editor", "Edited on the client; a push sends this check-in to the server.")
	}
	if err != nil {
		return nil, fmt.Errorf("demo check-in: %w", err)
	}
	before := result{"client": artifactSet(cli), "server": artifactSet(srv)}

	var rounds []round
	t := libfossil.TransportFunc(func(ctx context.Context, payload []byte) ([]byte, error) {
		resp, err := srv.HandleSync(ctx, payload)
		if err != nil {
			return nil, err
		}
		rounds = append(rounds, round{len(rounds) + 1, decodeXfer(payload), decodeXfer(resp), len(payload), len(resp)})
		return resp, nil
	})
	code, _ := srv.Config("project-code")
	scode, _ := srv.Config("server-code")
	opts := libfossil.SyncOpts{Pull: kind == "pull", Push: kind == "push", ProjectCode: code, ServerCode: scode}
	if kind == "push" {
		opts.User, opts.Password = "editor", "demo"
	}
	res, err := cli.Sync(ctx, t, opts)
	after := result{"client": artifactSet(cli), "server": artifactSet(srv)}
	out := result{"kind": kind, "checkin": made, "rounds": rounds, "before": before, "after": after}
	if err != nil {
		out["error"] = err.Error()
		return out, nil
	}
	out["filesSent"], out["filesRecvd"] = res.FilesSent, res.FilesRecvd
	return out, nil
}

type named struct {
	UUID   string `json:"uuid"`
	Kind   string `json:"kind"`
	Size   int    `json:"size"`
	Alg    string `json:"alg"`
	Hash   string `json:"hash"`
	OK     bool   `json:"ok"`
	Cards  string `json:"cards,omitempty"`
	ZCard  string `json:"zcard,omitempty"`
	ZCheck string `json:"zcheck,omitempty"`
}

// nameCheck re-hashes every stored artifact and compares it with its name
// (SHA1 for 40-digit names, SHA3-256 for 64), and for structural artifacts
// lists their card letters and recomputes the Z card over the lines above it.
func nameCheck(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	rows, err := repo.DB().Query(`SELECT b.rid, b.uuid, CASE WHEN EXISTS (SELECT 1 FROM event e
		WHERE e.objid = b.rid AND e.type = 'ci') THEN 'check-in' ELSE 'file' END
		FROM blob b WHERE b.size >= 0 ORDER BY b.rid`)
	if err != nil {
		return nil, err
	}
	type ref struct {
		rid        int64
		uuid, kind string
	}
	var refs []ref
	for rows.Next() {
		var x ref
		if rows.Scan(&x.rid, &x.uuid, &x.kind) == nil {
			refs = append(refs, x)
		}
	}
	rows.Close()
	out := []named{}
	for _, x := range refs {
		b, err := content.Expand(repo.DB(), fsltype.FslID(x.rid))
		if err != nil {
			return nil, err
		}
		n := named{UUID: x.uuid, Kind: x.kind, Size: len(b)}
		if len(x.uuid) == 40 {
			sum := sha1.Sum(b)
			n.Alg, n.Hash = "SHA1", hex.EncodeToString(sum[:])
		} else {
			sum := sha3.Sum256(b)
			n.Alg, n.Hash = "SHA3-256", hex.EncodeToString(sum[:])
		}
		n.OK = n.Hash == x.uuid
		if x.kind == "check-in" && len(b) >= 35 && bytes.HasPrefix(b[len(b)-35:], []byte("Z ")) {
			var letters []byte
			for _, line := range bytes.Split(bytes.TrimRight(b, "\n"), []byte("\n")) {
				if len(line) > 0 && (len(letters) == 0 || letters[len(letters)-1] != line[0]) {
					letters = append(letters, line[0])
				}
			}
			n.Cards = string(letters)
			n.ZCard = string(b[len(b)-33 : len(b)-1])
			sum := md5.Sum(b[:len(b)-35])
			n.ZCheck = hex.EncodeToString(sum[:])
		}
		out = append(out, n)
	}
	return out, nil
}

type colDiff struct {
	Column string `json:"column"`
	Rows   int    `json:"rows"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type tableState struct {
	Name   string    `json:"name"`
	Rows   int       `json:"rows"`
	Erased int       `json:"erased"`
	After  int       `json:"after"`
	Same   bool      `json:"same"`
	Diffs  []colDiff `json:"diffs"`
}

// derivedTables are the tables the repository-state draft derives from
// artifacts; rebuildDemo erases and recomputes exactly these.
var derivedTables = []string{"event", "plink", "mlink", "tagxref", "filename", "leaf"}

type snapshot struct {
	cols []string
	rows [][]string
}

// shown renders one SQLite value with its type, so 1.5 and '1.5' differ.
func shown(v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case []byte:
		return fmt.Sprintf("%q", string(x))
	case string:
		return fmt.Sprintf("%q", x)
	case float64:
		return strconvFloat(x)
	case time.Time:
		return x.UTC().Format("2006-01-02 15:04:05.000000")
	default:
		return fmt.Sprint(x)
	}
}

func strconvFloat(f float64) string { return fmt.Sprintf("%.17g", f) }

func snap(r *libfossil.Repo, table string) (snapshot, error) {
	rows, err := r.DB().Query("SELECT * FROM " + table)
	if err != nil {
		return snapshot{}, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := snapshot{cols: cols}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return snapshot{}, err
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			row[i] = shown(v)
		}
		out.rows = append(out.rows, row)
	}
	sort.Slice(out.rows, func(i, j int) bool { return strings.Join(out.rows[i], "\x00") < strings.Join(out.rows[j], "\x00") })
	return out, rows.Err()
}

// compare pairs rows by position (both sides sorted the same way) and reports
// each column that differs, with how many rows and one example.
func compare(a, b snapshot) (bool, []colDiff) {
	if len(a.rows) != len(b.rows) {
		return false, []colDiff{{Column: "(row count)", Rows: 1, Before: fmt.Sprint(len(a.rows)), After: fmt.Sprint(len(b.rows))}}
	}
	byCol := map[string]*colDiff{}
	var order []string
	for i := range a.rows {
		for c := range a.cols {
			if a.rows[i][c] != b.rows[i][c] {
				d, ok := byCol[a.cols[c]]
				if !ok {
					d = &colDiff{Column: a.cols[c], Before: a.rows[i][c], After: b.rows[i][c]}
					byCol[a.cols[c]] = d
					order = append(order, a.cols[c])
				}
				d.Rows++
			}
		}
	}
	var out []colDiff
	for _, c := range order {
		out = append(out, *byCol[c])
	}
	return len(out) == 0, out
}

// rebuildDemo shows that repository state is derived: on a throwaway copy it
// records the derived tables, erases them, rebuilds them from the stored
// artifacts alone, and compares the result with what was there before.
func rebuildDemo(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	data, err := serialize(repo)
	if err != nil {
		return nil, err
	}
	demos++
	name := fmt.Sprintf("demo-rebuild-%d.fossil", demos)
	memdb.Create(name, data)
	defer memdb.Delete(name)
	cp, err := libfossil.Open("/" + name)
	if err != nil {
		return nil, err
	}
	defer cp.Close()
	before := map[string]snapshot{}
	for _, t := range derivedTables {
		if before[t], err = snap(cp, t); err != nil {
			return nil, err
		}
	}
	for _, t := range derivedTables {
		if _, err := cp.DB().Exec("DELETE FROM " + t); err != nil {
			return nil, err
		}
	}
	erased := map[string]int{}
	for _, t := range derivedTables {
		_ = cp.DB().QueryRow("SELECT count(*) FROM " + t).Scan(&n0)
		erased[t] = n0
	}
	start := time.Now()
	rep, err := fslverify.Rebuild(cp.Inner())
	if err != nil {
		return nil, err
	}
	ms := time.Since(start).Milliseconds()
	var tables []tableState
	for _, t := range derivedTables {
		after, err := snap(cp, t)
		if err != nil {
			return nil, err
		}
		same, diffs := compare(before[t], after)
		tables = append(tables, tableState{Name: t, Rows: len(before[t].rows), Erased: erased[t], After: len(after.rows), Same: same, Diffs: diffs})
	}
	var artifacts int
	_ = cp.DB().QueryRow("SELECT count(*) FROM blob WHERE size >= 0").Scan(&artifacts)
	return result{"tables": tables, "artifacts": artifacts, "blobsChecked": rep.BlobsChecked, "ms": ms}, nil
}

var n0 int

func verify(_ []js.Value) (any, error) {
	if err := needRepo(); err != nil {
		return nil, err
	}
	start := time.Now()
	if err := repo.Verify(); err != nil {
		return result{"ok": false, "message": err.Error()}, nil
	}
	return result{"ok": true, "ms": time.Since(start).Milliseconds()}, nil
}

func main() {
	api := js.Global().Get("Object").New()
	for name, f := range map[string]func([]js.Value) (any, error){
		"open": open, "timeline": timeline, "files": files, "read": read, "annotate": annotate,
		"diff": diff, "artifact": artifact, "storage": storage, "verify": verify,
		"commit": commit, "export": export, "use": use, "query": query, "cloneDemo": cloneDemo, "syncDemo": syncDemo, "nameCheck": nameCheck, "rebuildDemo": rebuildDemo,
	} {
		api.Set(name, fn(f))
	}
	js.Global().Set("fossil", api)
	if cb := js.Global().Get("onFossilReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {}
}
