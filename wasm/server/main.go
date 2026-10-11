//go:build js

// Command rfcserver answers Fossil's sync protocol for the Worker, so each
// draft's repository can be cloned and pulled by a stock fossil client.
//
// The Worker hands over each repository's bytes once with fossil.load, then
// passes every sync request body to fossil.sync, which returns the response
// body. Each request is answered from a fresh in-memory copy of the bytes as
// loaded, and the copy is dropped afterwards: the server is read-only by
// construction, and nothing a client sends outlives its request.
package main

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"
	"syscall/js"

	libfossil "github.com/danmestas/go-libfossil"
	"github.com/danmestas/go-libfossil/db"
	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/vfs/memdb"
)

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

// The repositories as loaded, by name. memdb.Create takes ownership of the
// slice it is given, so each request opens a clone and these stay pristine.
var pristine = map[string][]byte{}

// Names each request's memdb database uniquely.
var requests uint64

func bytesOf(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

// load(name, Uint8Array): keep a repository's bytes for later requests.
func load(args []js.Value) (js.Value, error) {
	if len(args) != 2 {
		return js.Undefined(), fmt.Errorf("load takes a name and the repository bytes")
	}
	pristine[args[0].String()] = bytesOf(args[1])
	return js.Undefined(), nil
}

// sync(name, Uint8Array): one sync request body in, its response body out.
func sync(args []js.Value) (js.Value, error) {
	if len(args) != 2 {
		return js.Undefined(), fmt.Errorf("sync takes a name and the request body")
	}
	name := args[0].String()
	data, ok := pristine[name]
	if !ok {
		return js.Undefined(), fmt.Errorf("no repository named %q is loaded", name)
	}
	requests++
	memName := fmt.Sprintf("%s-%d.fossil", name, requests)
	memdb.Create(memName, bytes.Clone(data))
	defer memdb.Delete(memName)
	r, err := libfossil.Open("/" + memName)
	if err != nil {
		return js.Undefined(), err
	}
	defer r.Close()
	resp, err := r.HandleSync(context.Background(), bytesOf(args[1]))
	if err != nil {
		return js.Undefined(), err
	}
	out := js.Global().Get("Uint8Array").New(len(resp))
	js.CopyBytesToJS(out, resp)
	return out, nil
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
	api.Set("load", fn(load))
	api.Set("sync", fn(sync))
	js.Global().Set("fossilServer", api)
	if cb := js.Global().Get("onFossilServerReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {}
}
