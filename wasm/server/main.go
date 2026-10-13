//go:build js

// Command rfcserver answers Fossil's sync protocol for the Worker, so each
// draft's repository can be cloned, pulled and pushed with a stock fossil
// client.
//
// It keeps no state. The Worker's Durable Object holds each repository's
// bytes and passes them in with every call; a call opens an in-memory copy,
// works on it, and hands back the new bytes only when the repository gained
// artifacts. The bytes it hands back can always be published: every account
// but nobody has its password and capabilities cleared. Accounts that may
// push are given to each call, from the Worker's secret, and exist only in
// that call's copy.
package main

import (
	"bufio"
	"context"
	"fmt"
	"sort"
	"strings"
	"syscall/js"

	libfossil "github.com/danmestas/go-libfossil"
	"github.com/danmestas/go-libfossil/db"
	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/ext/serdes"
	"github.com/ncruces/go-sqlite3/vfs/memdb"
)

// What a pushing account may do: clone, read, check in.
const pusherCaps = "gio"

func init() {
	db.Register(db.DriverConfig{
		Name: "sqlite3",
		BuildDSN: func(path string, pragmas map[string]string) string {
			// The in-memory VFS keeps no journal files; a memory journal suffices.
			keys := make([]string, 0, len(pragmas))
			for k := range pragmas {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			var parts []string
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

// Names each call's memdb databases uniquely.
var opened uint64

// openCopy opens data as a repository in memory. memdb takes ownership of
// data; close drops the database.
func openCopy(data []byte) (r *libfossil.Repo, close func(), err error) {
	opened++
	name := fmt.Sprintf("repo-%d.fossil", opened)
	memdb.Create(name, data)
	r, err = libfossil.Open("/" + name)
	if err != nil {
		memdb.Delete(name)
		return nil, nil, err
	}
	return r, func() { r.Close(); memdb.Delete(name) }, nil
}

// artifacts summarises the blob table, to tell whether a call added any.
// Phantoms are counted apart from held content: a push's first round records
// the artifacts it will send as phantoms, and the round that sends them fills
// those rows in, adding none.
func artifacts(r *libfossil.Repo) (string, error) {
	var s string
	err := r.DB().QueryRow("SELECT count(*) || '/' || coalesce(max(rid), 0) || '/' || coalesce(sum(size >= 0), 0) FROM blob").Scan(&s)
	return s, err
}

// addPushers gives each "login:password" line its account in this copy.
func addPushers(r *libfossil.Repo, accounts string) error {
	sc := bufio.NewScanner(strings.NewReader(accounts))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		login, password, ok := strings.Cut(line, ":")
		if !ok || login == "" || password == "" || login == "nobody" {
			return fmt.Errorf("an account line is not login:password")
		}
		if _, err := r.DB().Exec("DELETE FROM user WHERE login=?", login); err != nil {
			return err
		}
		if err := r.CreateUser(libfossil.UserOpts{Login: login, Password: password, Caps: pusherCaps}); err != nil {
			return err
		}
	}
	return sc.Err()
}

// publishable clears every account but nobody, then returns the database.
func publishable(r *libfossil.Repo) ([]byte, error) {
	if _, err := r.DB().Exec("UPDATE user SET pw='', cap='' WHERE login<>'nobody'"); err != nil {
		return nil, err
	}
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

// changed returns the copy's publishable bytes if it gained artifacts since
// before, else nil.
func changed(r *libfossil.Repo, before string) ([]byte, error) {
	after, err := artifacts(r)
	if err != nil || after == before {
		return nil, err
	}
	return publishable(r)
}

// sync(repo, request, accounts, loginCookie): one sync request body against
// the repository's bytes. loginCookie is the request's x-f-l-c cookie, "" when
// it has none: once a client has seen this server's version it moves its
// login card from the body to that cookie, so a round that arrives without
// it is answered as nobody. Returns {reply, repo}, repo being the new bytes
// or null.
func syncCall(args []js.Value) (js.Value, error) {
	if len(args) != 4 {
		return js.Undefined(), fmt.Errorf("sync takes the repository, the request body, the accounts and the login cookie")
	}
	r, close, err := openCopy(bytesOf(args[0]))
	if err != nil {
		return js.Undefined(), err
	}
	defer close()
	if err := addPushers(r, args[2].String()); err != nil {
		return js.Undefined(), err
	}
	before, err := artifacts(r)
	if err != nil {
		return js.Undefined(), err
	}
	reply, err := r.HandleSyncWithOpts(context.Background(), bytesOf(args[1]), libfossil.HandleOpts{LoginCookie: args[3].String()})
	if err != nil {
		return js.Undefined(), err
	}
	repo, err := changed(r, before)
	if err != nil {
		return js.Undefined(), err
	}
	out := js.Global().Get("Object").New()
	out.Set("reply", toJS(reply))
	out.Set("repo", toJS(repo))
	return out, nil
}

// merge(repo, seed): pull every artifact of seed, the repository as a release
// published it, into repo. Returns the new bytes, or null if repo had them all.
func mergeCall(args []js.Value) (js.Value, error) {
	if len(args) != 2 {
		return js.Undefined(), fmt.Errorf("merge takes the repository and the published repository")
	}
	r, close, err := openCopy(bytesOf(args[0]))
	if err != nil {
		return js.Undefined(), err
	}
	defer close()
	seed, closeSeed, err := openCopy(bytesOf(args[1]))
	if err != nil {
		return js.Undefined(), err
	}
	defer closeSeed()
	code, err := r.Config("project-code")
	if err != nil {
		return js.Undefined(), err
	}
	if seedCode, err := seed.Config("project-code"); err != nil || seedCode != code {
		return js.Undefined(), fmt.Errorf("the published repository is a different project")
	}
	before, err := artifacts(r)
	if err != nil {
		return js.Undefined(), err
	}
	t := libfossil.TransportFunc(func(ctx context.Context, p []byte) ([]byte, error) { return seed.HandleSync(ctx, p) })
	if _, err := r.Sync(context.Background(), t, libfossil.SyncOpts{Pull: true, ProjectCode: code}); err != nil {
		return js.Undefined(), err
	}
	repo, err := changed(r, before)
	if err != nil {
		return js.Undefined(), err
	}
	return toJS(repo), nil
}

func bytesOf(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

// toJS copies b into a new Uint8Array; nil is null.
func toJS(b []byte) js.Value {
	if b == nil {
		return js.Null()
	}
	out := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(out, b)
	return out
}

// fn returns the result, or an object {error} the Worker turns into an HTTP
// error, so a Go failure never surfaces as an uncaught JavaScript exception.
func fn(f func([]js.Value) (js.Value, error)) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) (ret any) {
		defer func() {
			if p := recover(); p != nil {
				ret = errorValue(fmt.Errorf("panic: %v", p))
			}
		}()
		v, err := f(args)
		if err != nil {
			return errorValue(err)
		}
		return v
	})
}

func errorValue(err error) js.Value {
	o := js.Global().Get("Object").New()
	o.Set("error", err.Error())
	return o
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("sync", fn(syncCall))
	api.Set("merge", fn(mergeCall))
	js.Global().Set("fossilServer", api)
	if cb := js.Global().Get("onFossilServerReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {}
}
