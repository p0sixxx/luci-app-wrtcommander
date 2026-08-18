# FileXplorer

**Package:** `luci-app-filexplorer` — displayed in LuCI as **FileXplorer**.

A native, admin-grade file explorer for LuCI on OpenWrt. **This is the
runtime/development edition** described in the project brief: a
complete, working application you copy onto a running OpenWrt 25.12.x
router and use immediately, with no package manager, no `.ipk`, and no
SDK/toolchain involved. A proper OpenWrt package build is the planned
next stage, once this has been exercised on real hardware.

## What it is

A **two-pane commander**, the layout Norton/Midnight/Total Commander made
standard: two independent directory panels side by side, one of them
active, and every operation defaulting to "from the active panel to the
other one".

```
┌─ /etc/config ───────────────┬─ /tmp ──────────────────────┐
│ ↑ ..                        │ ↑ ..                        │
│ 📁 wireless        DIR      │ 📄 dhcp.leases      1.2 KiB │
│ 📄 network      2.1 KiB     │ 📄 log              4.0 KiB │
│ ■ 📄 firewall   1.8 KiB     │ 📁 run              DIR     │
├─────────────────────────────┼─────────────────────────────┤
│ 1 item selected · 1.8 KiB   │ 12 items                    │
│              4.2 MiB free   │             28.1 MiB free   │
├─────────────────────────────┴─────────────────────────────┤
│ F3 View  F4 Edit  F5 Copy  F6 Move  F7 New folder  F8 Del │
└───────────────────────────────────────────────────────────┘
```

- Two panels with independent path, sorting and selection; **Tab**
  switches, the active one is outlined
- **F5 Copy / F6 Move default to the other panel's directory** — the
  reason two panels are worth having
- Full keyboard control: arrows, PageUp/Down, Home/End, Enter to open,
  Backspace to go up, Insert/Space to mark, Ctrl+A, Ctrl+R
- Function-key bar that is also clickable, so nothing depends on having
  a keyboard
- Per-panel status line: item count, selected size, free space on that
  filesystem
- Create / rename / delete / copy / move, one item or many
- Streamed HTTP upload and download (never base64-through-JSON)
- Text viewer and editor with atomic save and conflict detection
- Permissions (chmod) and owner/group (chown) editing
- Filename search, current directory or recursive, with result caps
- **English and Russian**, through LuCI's normal gettext/`.lmo` pipeline
- A single, mandatory path-validation layer shared by every operation,
  written to resist `../` traversal, encoded traversal, and symlink
  escape (see **Security model** below)

On a phone the two panels do not fit, so below 900px the app shows one
panel at a time with a switcher. The panel *model* is unchanged, so
"copy to the other panel" still means exactly what it means on desktop.

## Requirements

- OpenWrt 25.12.x (should also work on 23.05/24.10 - the ubus/rpcd/ucode
  APIs used here have been stable across those releases)
- LuCI (JS-based views, i.e. any current LuCI)
- `rpcd` with `rpcd-mod-ucode` (provides the `/usr/share/rpcd/ucode`
  plugin loader)
- `ucode` (the interpreter itself)
- `uhttpd`
- `luci-lua-runtime` - **only** needed for upload/download (see below);
  everything else (browsing, edit, delete, copy, move, permissions,
  search) works without it

All of the above are standard parts of any router that already runs
stock LuCI, so on a normal install there is nothing extra to add
except `ucode`/`rpcd-mod-ucode` if your image is unusually minimal.

## Architecture

```
LuCI JS view (www/luci-static/resources/view/filexplorer.js)
        |
        |-- ubus/rpcd  ------------------->  usr/share/rpcd/ucode/filexplorer.uc
        |     (list, stat, read, write,        "luci.filexplorer" ubus object
        |      mkdir, create, rename,           - every method funnels through
        |      remove, copy, move, chmod,         canon() before touching the
        |      chown, search, disk_info)          filesystem (see below)
        |
        `-- plain HTTP  ------------------->  usr/lib/lua/luci/controller/filexplorer.lua
              (GET .../download?path=...        streamed upload/download only -
               POST .../upload?dest=...)         arbitrarily large files never
                                                  go through JSON/ubus
```

Everything that can reasonably go through ubus does. Upload and
download are the deliberate exception: JSON-RPC has no streaming and a
practical message-size ceiling, so those two operations use plain HTTP
against a small Lua controller instead. That controller re-implements
the same canonical path-validation pipeline as the ucode backend
(`canon_path()` in the Lua file mirrors `canon()` in the ucode file) -
see **Known limitations** for why this one piece of logic exists
twice, and what that implies for future changes.

> **Moving the menu entry moves those endpoints too.** The app lives at
> `admin/services/filexplorer`, and the upload/download URLs are
> `admin/services/filexplorer/upload` and `…/download`. That path is
> spelled out in four places - `menu.d/luci-app-filexplorer.json`, the
> `entry()` calls in the Lua controller, the `L.url(…)` calls in the JS
> view, and the two HTTP test scripts. Change one and the file transfers
> break silently (the UI keeps working, uploads just 404), so change all
> four together.

### Why ucode for the backend, and Lua only for streaming

OpenWrt/LuCI is actively moving away from Lua toward ucode + rpcd for
everything server-side. The filesystem backend here is written
entirely in ucode against `rpcd-mod-ucode` (no shell exec with
user-controlled strings anywhere - the one external process it runs,
`df`, is invoked via the array form of `fs.popen()`, i.e. `execvp()`
with a literal argv, never `/bin/sh -c`). Streamed HTTP upload/download
still uses a small Lua controller because LuCI's mature, well-tested
`luci.http` multipart parser and `setfilehandler()` streaming API are
the safest way to move large files without buffering them fully in
RAM, and reimplementing that from scratch in ucode on top of raw
`uhttpd` ucode CGI primitives was judged a worse safety trade for a
first-stage deliverable. If a router's image doesn't carry
`luci-lua-runtime`, upload/download are the only two features
affected; `install.sh` checks for this and warns rather than failing.

### `src/` vs `runtime/`

There is no `src/` directory: since nothing here is compiled or
transpiled, `runtime/` **is** the source. Duplicating it into a
separate `src/` tree would only create drift risk between the two
copies with no corresponding benefit - the brief allows adapting the
suggested layout to the actual architecture, and for an interpreted,
copy-to-target app this is that adaptation.

## Repository layout

```
runtime/    exactly what gets copied onto the router (see deploy/MANIFEST)
deploy/     install.sh / uninstall.sh / restart.sh / MANIFEST
po/         translations: .pot template, .po sources, build/verify tooling
tests/      on-router test suite (functional, security, upload,
            download, editor) + test filesystem generator
README.md   this file
```

## Installing on a router (development workflow)

```sh
# from your workstation
scp -r runtime deploy root@ROUTER:/tmp/filexplorer/
ssh root@ROUTER

# on the router
cd /tmp/filexplorer/deploy
sh install.sh
```

`install.sh`:

1. refuses to run as anything but root
2. checks this is actually an OpenWrt system with `ubus`, `rpcd`,
   `ucode` and LuCI present, and warns (but doesn't abort) if
   `luci-lua-runtime` is missing
3. parses the ucode backend with `ucode filexplorer.uc` and aborts
   *before touching the live install* if it fails to parse
4. copies every file listed in `deploy/MANIFEST` to its absolute
   destination, leaving an existing `/etc/config/filexplorer` alone
   unless you pass `--force-config`
5. reloads `rpcd` (picks up the new ACL file and ucode plugin) and
   clears LuCI's dispatch index cache
6. verifies `luci.filexplorer` is actually registered on `ubus list`
   and reports clearly if it isn't

It deliberately never restarts `uhttpd` - static files and the Lua
controller are picked up on the next request with no restart needed.

Open **LuCI -> Services -> FileXplorer**.

### Re-deploying after a change

Edit files under `runtime/`, `scp` the changed one(s) over, then:

```sh
sh /tmp/filexplorer/deploy/restart.sh
```

This re-validates the ucode syntax, reloads `rpcd`, and clears the
index cache - the fast inner loop for iterating on the app.

### Uninstalling

```sh
sh /tmp/filexplorer/deploy/uninstall.sh          # keeps your config
sh /tmp/filexplorer/deploy/uninstall.sh --purge   # also removes it
```

`uninstall.sh` only ever touches the exact absolute paths listed in
`deploy/MANIFEST` (seven fixed files) - it never does a wildcard or
recursive delete, so it cannot reach into user data or unrelated
OpenWrt files by construction.

## Testing

```sh
cd /tmp/filexplorer/tests
sh run-all.sh
```

This builds a disposable test tree at `/tmp/filexplorer-test/`
(Unicode names, spaces, hidden files, a large file, symlinks including
a deliberately broken one) and runs, in order:

- `fs-tests.sh` - create, mkdir, list, stat, read, write, rename,
  copy, move, delete, chmod, search, disk_info; Unicode, spaces,
  hidden files, long names, symlinks
- `security-tests.sh` - temporarily restricts `allowed_root` to the
  test tree, then asserts `../`, `../../`, absolute-path escape,
  literal `%2e%2e` / `%252e%252e` (proving there is no double-decode),
  backslash sequences, and direct/nested symlink escape are all
  rejected on every mutating method, not just `list`/`stat`; restores
  the original `allowed_root` on exit even if a test fails
- `editor-tests.sh` - empty file, UTF-8/Russian text, JSON, a
  UCI-style config, oversized-file rejection, external-modification
  conflict detection, and read/write behaviour against `/rom`
  (read-only overlay layer)
- `upload-tests.sh` / `download-tests.sh` (need `curl`) - empty,
  small, Unicode-named, space-named and large (multi-MiB, streamed)
  files; overwrite protection; rejecting a write into `/rom`; 404 on a
  nonexistent path; downloading through a symlink; directory download
  rejected

Each stage prints `PASS`/`FAIL` per assertion and a final count;
`run-all.sh` exits non-zero if anything failed.

Two things are intentionally **not** simulated, with the reasoning
left in the scripts themselves: literal NUL-byte injection (`ubus
call`'s arguments are C strings - there is no way to put a NUL through
the CLI to begin with; the backend still guards against one arriving
from a raw ubus/JSON-RPC client) and classic owner/group "permission
denied" (rpcd runs as root, which bypasses Unix permission bits by
definition - the read-only-filesystem case against `/rom` is the
realistic "write denied" scenario for a privileged whole-filesystem
tool like this one).

## Backend API (`luci.filexplorer` ubus object)

| Method | Purpose |
|---|---|
| `list` | directory contents (name, type, size, mtime, mode, owner, group, symlink target) |
| `stat` | full metadata for one path, plus mount/filesystem info |
| `read` | preview/edit/head/tail of a file, base64, size-capped |
| `write` | atomic save (temp file + rename), with mtime/size conflict check |
| `mkdir` / `create` | new directory / new empty file |
| `rename` | rename within the same directory |
| `remove` | recursive delete, one or many paths, per-item results |
| `copy` / `move` | recursive, one or many items; `move` uses `rename()` when possible and falls back to copy+delete across filesystems |
| `chmod` / `chown` | permission / owner changes |
| `search` | filename search, current dir or recursive, capped by depth/scanned/result-count |
| `disk_info` | free/used/total for the filesystem under a path, via `df` (never a recursive `du`) |

Every response is either `{"ok": true, ...}` or `{"ok": false, "error":
{"code": "EACCES", "message": "..."}}`; `remove`/`copy`/`move` always
reply with a top-level `ok: true` envelope and a `results: [...]`
array carrying the per-item outcome, since a bulk operation can
partially succeed.

## ACL

`usr/share/rpcd/acl.d/luci-app-filexplorer.json` defines separate
scopes - `luci-app-filexplorer-read`, `-write`, `-delete`, `-chmod`,
`-chown` - plus `luci-app-filexplorer`, which is what the menu entry
and a full-access admin session need. Root/admin LuCI sessions get
every scope automatically (stock OpenWrt's default `root` login grants
`read '*'` / `write '*'`); a restricted, non-root LuCI user only gets
what you explicitly assign in `/etc/config/rpcd`. Upload and download
are gated in the Lua controller itself, by asking rpcd whether the
current session has `ubus`/`luci.filexplorer`/`list` (read) or `write`
access before touching the filesystem - never by hiding the button.

## Security model

```
LuCI JS view
     |
     v
ubus / HTTP           <- untrusted input arrives here
     |
     v
ACL check              (rpcd, or session_has_access() in the Lua controller)
     |
     v
canon()                 the ONE path validation layer:
     |                     normalize (resolve "." and ".." lexically,
     |                      never touching the filesystem)
     |                   -> containment check against allowed_root
     |                   -> resolve symlinks for the existing portion
     |                      via realpath()
     |                   -> containment check again on the resolved path
     v
POSIX filesystem call    (ucode fs module / Lua io+nixio - never a shell)
```

No filesystem-affecting method in `filexplorer.uc`, and no HTTP action
in `filexplorer.lua`, touches a path it did not get back from this
function. Concretely, this is what's covered by `security-tests.sh`:

- `../`, `../../`, deep `../../../` traversal
- absolute-path escape (`/etc/passwd` while `allowed_root` is
  restricted to a subtree)
- literal `%2e%2e` and double-encoded `%252e%252e` are treated as
  ordinary (nonexistent) filenames, proving the backend performs no
  decoding pass of its own that a double-encoding trick could exploit
- backslash sequences (not a path separator on Linux, so they're just
  part of a filename)
- a symlink living inside the allowed root that points outside it
  (direct, and nested one directory deep)
- the same containment check applied to every mutating method
  (`write`, `remove`, `mkdir`, `chmod`, ...), not only `list`/`stat`
- deleting/renaming the allowed root itself is refused outright

Other deliberate choices: uploads and downloads never buffer a whole
file in RAM (fixed 64 KiB chunks throughout); `read()` enforces
`preview_max_size`/`editor_max_size` server-side regardless of what
the client claims; `search()` is bounded by max depth, max directories
scanned and max results so a query can never turn into an unbounded
`find /`; special files (device nodes, FIFOs, sockets) are never
silently "copied" - copying one is a hard, explicit error rather than
producing a corrupt or misleading copy; `disk_info` uses `df`, never a
recursive `du`; directory listings never compute recursive directory
size.

## Configuration (`/etc/config/filexplorer`)

```
config filexplorer 'main'
	option enabled '1'
	option allowed_root '/'
	option show_hidden '1'
	option preview_max_size '524288'    # 512 KiB
	option editor_max_size '1048576'    # 1 MiB
	option search_max_results '500'
	option search_max_depth '12'
	option search_max_scanned '20000'
	option debug '0'
```

`allowed_root` is read fresh on every call, so the backend is already
architecturally ready for a future "restrict to `/mnt/storage`"
deployment - the frontend never enforces or even knows the policy, it
only reflects whatever `list`/`stat` tell it.

### Debug mode

```sh
uci set filexplorer.main.debug='1'
uci commit filexplorer
sh deploy/restart.sh
tail -f /tmp/filexplorer-debug.log
```

Each line records method, path, duration and success/failure -
**never** file contents, credentials, or request bodies.

## UI notes

The JS view (`filexplorer.js`) uses only LuCI's own framework (`ui`,
`dom`, `rpc`, `E()`), plain Unicode glyphs for icons (no icon library),
and a companion stylesheet (`filexplorer.css`) that inherits the active
LuCI theme's colors instead of hardcoding a light or dark palette.

Commander conventions worth knowing:

- **Cursor and selection are different things.** The cursor is the
  outlined row you move with the arrow keys; selection is what you mark
  with Insert/Space or the `□` box. An action with nothing marked
  applies to the row under the cursor, which is what makes single-file
  work fast.
- Panel paths, sort order, active panel, hidden-file visibility and
  "folders first" all persist in `localStorage`.
- Destructive actions list exactly which paths they will touch, and add
  a louder warning when a core system path (`/etc`, `/overlay`, `/rom`,
  `/usr`, `/lib`, `/bin`, `/sbin`, `/boot`, `/www`) is among them - a UX
  nudge only; the backend enforces the real rules regardless of what the
  UI shows or hides.

## Languages

The interface is fully translated into **English and Russian** using
LuCI's standard gettext pipeline, so it follows whatever language LuCI
itself is set to:

```sh
uci set luci.main.lang=ru
uci commit luci
```

or **System → System → Language**. With `lang=auto` LuCI follows the
browser's `Accept-Language`.

The compiled catalog installs to
`/usr/lib/lua/luci/i18n/filexplorer.ru.lmo`. Note that this translates
*FileXplorer*; for the surrounding LuCI chrome to be Russian too you
need LuCI's own catalog (`luci-i18n-base-ru`) — `install.sh` warns if
it is missing.

The **menu entry itself is translated too** — it reads "FileXplorer" in
English and "Файловый менеджер" in Russian. Menu titles go through the
same catalog as everything else (upstream apps list
`menu.d/…json` as a source for their title msgid), so the string lives
in `po/` next to the rest and `po/extract.py` picks it up from
`menu.d/luci-app-filexplorer.json` automatically.

Sources, tooling and instructions for adding a language live in
[`po/README.md`](po/README.md). Russian uses proper three-form plurals
(`1 объект / 2 объекта / 5 объектов`) via `N_()`.

## Known limitations (first stage)

- **Two copies of the path-validation logic.** The ucode backend and
  the Lua upload/download controller each implement `canon()`/
  `canon_path()` independently, because ubus/rpcd and raw HTTP CGI are
  separate runtimes with no shared import path between them. They were
  written from the same design and are covered by
  `security-tests.sh`/`download-tests.sh` against both, but a future
  policy change (e.g. a different `allowed_root` semantics) must be
  made in both places.
- **No archive support.** Extract/create-archive is out of scope for
  this stage by design (see brief §77) rather than shipped unsafely
  (Zip Slip class issues); `Open with` in the UI is limited to
  Preview/Edit/Download for now, with the context-menu architecture
  already able to grow more actions later.
- **No HTTP Range support on download** (no resume for a large,
  interrupted download).
- **No per-button loading-state debounce on every dialog action** -
  most destructive actions already go through a confirmation modal,
  which is the primary defense against accidental double-submission,
  but a handful of buttons don't yet disable themselves while their
  request is in flight.
- **No free-space preflight before a copy.** Knowing in advance whether
  a copy fits would need a recursive size scan of the source, which is
  exactly the kind of scan this app avoids everywhere else for
  performance on slow flash. Instead `ENOSPC` is surfaced as a clear
  "No space left on device" when it happens, and the partially written
  target file is deleted rather than left behind.
- **Binary detection is a NUL-byte heuristic** (the same class of
  check `git` uses), not a full content-type sniff.
- **Some function keys are also browser shortcuts.** The view calls
  `preventDefault()` on the keys it handles, so F3/F5/F7 do not trigger
  find/reload/caret-browsing while the file list has focus - but every
  F-key action is also a clickable button, so nothing depends on the
  browser cooperating.
- **Translations are shipped pre-compiled.** `.lmo` is a binary format
  built by LuCI's `po2lmo`; editing a `.po` here has no effect until the
  catalog is rebuilt (see `po/README.md`).
- Not yet exercised on real OpenWrt 25.12.x hardware in this session -
  see **Testing** and **Next step** below.

## Next step: turning this into a real OpenWrt package

1. Write a `Makefile` per `runtime/` file's final destination (this
   maps almost one-to-one onto `deploy/MANIFEST`, which was written
   with exactly this reuse in mind).
2. Declare real `DEPENDS` (`rpcd`, `rpcd-mod-ucode`, `ucode`, `uhttpd`,
   `luci-base`, `luci-lua-runtime`).
3. Move `/etc/config/filexplorer` under `define Package/conffiles` so
   opkg treats it as user configuration across upgrades.
4. Add `postinst`/`prerm` scripts that do what `install.sh`/
   `uninstall.sh` already do (reload `rpcd`, clear the index cache),
   minus the manual-copy-specific bits.
5. Drop the committed `.lmo` and let the build produce it instead:
   including `$(TOPDIR)/feeds/luci/luci.mk` makes `luci.mk` compile
   `po/<lang>/*.po` and emit `luci-i18n-filexplorer-<lang>` subpackages
   automatically, which is the normal way translations ship. The
   `po/` layout here already matches what `luci.mk` expects, so this
   step should be a deletion rather than a rewrite.
6. Build and test the `.ipk` with the OpenWrt SDK, then run this same
   `tests/` suite against a router that installed it via `opkg`
   instead of `scp`.
