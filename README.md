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
┌───────────────────────────────────────────────────────────┐
│ FileXplorer │ 👁F3 📝F4 📋F5 ➡F6 📂F7 🏷F2 🗑F8 │ 📄 ⬍⬍ 🔍  ⌨ ⚙ │
├─ /etc/config ───────────────┬─ /tmp ──────────────────────┤
│ ↑ ..                        │ ↑ ..                        │
│ 📁 wireless        DIR      │ 📄 dhcp.leases      1.2 KiB │
│ 📄 network      2.1 KiB     │ 📄 log              4.0 KiB │
│ ■ 📄 firewall   1.8 KiB     │ 📁 run              DIR     │
├─────────────────────────────┼─────────────────────────────┤
│ 1 item selected · 1.8 KiB   │ 12 items                    │
│              4.2 MiB free   │             28.1 MiB free   │
└─────────────────────────────┴─────────────────────────────┘
```

- Two panels with independent path, sorting and selection; **Tab**
  switches, the active one is outlined
- **F5 Copy / F6 Move default to the other panel's directory** — the
  reason two panels are worth having
- Full keyboard control: arrows, PageUp/Down, Home/End, Enter to open,
  Backspace to go up, Insert/Space to mark, Ctrl+A, Ctrl+R
- Every action is also an icon button in the header, so nothing depends
  on having a keyboard
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
`dom`, `rpc`, `E()`), Unicode glyphs for icons plus one drawn pair of
inline SVG paths (no icon library), and a companion stylesheet
(`filexplorer.css`).

Layout, top to bottom: a single header row, then the two panels.

The header carries the app name, then every action as an icon button -
the function keys (F3 View, F4 Edit, F5 Copy, F6 Move, F7 New folder,
F2 Rename, F8 Delete) with their key printed next to the icon, then the
actions that have no function key (New file, Upload, Download, Search),
and finally, pushed to the right, the selection count and the two
page-level buttons (Keyboard shortcuts, Settings). Every button carries
a `title` and an `aria-label` with the full wording, so the icons are
labelled for both hover and screen readers.

The glyphs were picked by rendering the candidates for each action at
button size and comparing them, not from the code point names. Two
results worth recording: the eye needs its `U+FE0F` variation selector
to keep its colour, while the keyboard (`U+2328`) must *not* have one or
it renders washed out.

Upload and Download are the exception, and the one pair that has to read
as a matched set - the same tray with the arrow mirrored. No emoji pair
does that: the outbox/inbox trays (`U+1F4E4`/`U+1F4E5`) differ only by
the direction of a small arrow and side by side read as the same icon
twice, and the boxed arrows (`U+2B06`/`U+2B07`) are a matched pair but
the only flat tiles in a row of pictograms. So those two are drawn
instead, by `trayIcon()` in the view - inline SVG, no icon library, one
shared tray path and a mirrored arrow. The strokes use `currentColor`
with the arrow in `--fx-accent`, so both themes are handled without a
second palette. The SVG is sized `1em` *inside* `.fx-act-ico`, which is
already `1.35em`: sizing it in `em` again there compounds the two and
leaves those two buttons taller than the rest of the row. Separators group the three
runs. Below 768 px the row wraps: the title takes a line of its own, the
separators are hidden and the buttons share the width.

The selection count shows only while something is actually marked - it
counts marked entries, not the row the cursor happens to sit on.

### Dialogs

**Keyboard shortcuts** is a two-column grid only as wide as its content
and centred in the dialog, with the keys right-aligned against the middle
gutter and the descriptions starting just after it, grouped into
Navigation / Selection / File actions. It replaced a full-width table
with a 40% key column, which left a stripe of empty space between every
key and the thing it does.

**Settings** is deliberately short — a settings dialog is where options
accumulate. It carries what changes how the list reads or where the
panels start, one switch each: show hidden files, folders first, remember
panel paths, reset column widths, and wrap long lines in the editor.
Anything that belongs to a single file (permissions, say) lives on that
file instead.

A note on where these render: LuCI modals are appended to `<body>`, and
so is the context menu. Both are therefore *outside* `.fx-app`, where the
`--fx-*` tokens used to be declared — so none of them resolved. Measured
before the fix: keycaps with no border or background, section rules 0px
wide, muted hints rendering at full contrast, and a context menu with no
border and square corners. The token block is now declared on `:root` as
well, with `.fx-app` and `.fx-ctx` repeating it so a theme that scopes
its own `--proton-*` below `:root` is still picked up locally.

### Theming

The stylesheet is written against the
[Proton2025](https://github.com/ChesterGoodiny/luci-theme-proton2025)
theme's CSS custom properties - `--proton-bg-tertiary`, `--proton-accent`,
`--proton-radius`, `--proton-shadow-sm` and so on - each with a fallback
chain ending in a neutral grey. On that theme the app inherits its exact
surfaces, accent, radii and shadows, and follows its light mode for free,
because light mode there only reassigns the same variables. On any other
theme the fallbacks keep it readable. Nothing hardcodes a palette.

**Sizing to the display.** Two panels of files want more room than a
settings form, so the view takes what the window actually has, in two
separate steps.

*Height* is stretched so the panels reach the bottom of the window
instead of a fixed guess at the theme's header and footer heights.

*Width* relaxes the max-width of the theme's own content container
(`#maincontent`) through an `.fx-wide` class, and only for as long as
this page is open. The app itself is never moved or resized - the
container keeps its own centring, padding and any sidebar offset - and
`widenContainer()` applies the class, measures, and takes it straight
back off if the container no longer ends inside the window.

The target is `max(var(--proton-page-max-width, 990px), 67.5%)`: about
two thirds of the window, so the panels get real room without stretching
a file name into an uncomfortably long line to scan, and never below the
theme's own cap, so on a small screen this can only add room and never
take it away. Measured on Proton2025:

| viewport | before | after |
|---------:|-------:|------:|
| 1920 | 990 | 1296 |
| 1600 | 990 | 1080 |
| 1366 | 990 | 990 |
| 1280 | 990 | 990 |
| 1024 | 990 | 990 |

From 1366 down the floor is what applies, so the theme's own width is
kept unchanged. No horizontal scroll at any of those, nor at 414/360
where the header wraps instead.

The revert check is not decoration. On Proton2025 `#maincontent` is a
flex item that grows into the space the cap was holding back, so raising
the cap simply works. A classic sidebar theme instead combines
`width: 100%` with a left margin for the menu, and there the same rule
can push the right edge off screen - so the class comes back off and that
theme keeps its own width. Earlier versions tried to widen the app itself
(CSS `100vw` plus a negative margin, then a position computed from
measured geometry) and both shipped a layout that hung off the edge of
the screen on a real router, which is why this one changes one property
of the theme's container and verifies the result rather than trusting it.

### Columns

Size, Modified and Mode are centred in their own column, header and
values alike, so each reads as a labelled block instead of as text
crowded against its neighbour.

Their widths are draggable. Each of the three carries a handle on its
left edge in the header row; dragging widens or narrows that column and
the Name column absorbs the difference. A double-click on a handle puts
that column back to its default. Widths are kept as CSS variables on the
app root rather than on the cells, which means one drag moves the column
in *both* panels and every row follows without a re-render, and they are
remembered in `localStorage` between visits.

Two things that had to be got right here: `.fx-th` must not use the
shared `all .2s` transition, or the header cell animates its flex-basis
and lags a fifth of a second behind the pointer while the rows below it
track it exactly; and each drag is clamped to a per-column minimum and
maximum, so no drag can squeeze the Name column away.

### Context menu

Right-click is a complete alternative to the header and the keyboard,
not a subset. It carries Open / View / Edit / Download, Copy / Move /
Rename / Delete, Select / Select all / Clear selection, New file / New
folder / Upload, Permissions / Properties, and Search / Refresh, with
each item showing the same key that triggers it from the header.

Which entries an action applies to follows the same rule as the function
keys: an explicit selection wins, and the clicked row is used only when
nothing is marked. Right-clicking a row that is *outside* the selection
acts on that row alone. So "mark three, right-click one of them, Delete"
means all three, and the menu says so - the entries that operate on many
items are labelled with the count.

The menu also opens on the empty space below the rows, where it drops the
per-file entries and keeps the ones that act on the directory.

The menu is appended to `<body>`, so it can escape the panels' overflow
clipping - which means it renders *outside* `.fx-app` and did not
resolve any of the `--fx-*` tokens: it had no border, square corners and
invisible separators. The token block is declared on `.fx-app, .fx-ctx`
for that reason.

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

The **menu entry goes through the catalog too**, though it resolves to
"FileXplorer" in every language: the product name is a name, not a
description, so it is not translated. Menu titles use the same catalog as
everything else (upstream apps list `menu.d/…json` as a source for their
title msgid), so the string lives in `po/` next to the rest and
`po/extract.py` picks it up from `menu.d/luci-app-filexplorer.json`
automatically.

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
