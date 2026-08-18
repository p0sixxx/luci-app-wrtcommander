# Translations

FileXplorer ships its interface strings through LuCI's normal gettext
pipeline, so it translates the same way any other `luci-app-*` does.

```
po/templates/filexplorer.pot   source strings, regenerated from the sources
po/ru/filexplorer.po           Russian translation
po/extract.py                  extracts strings into the .pot
po/verify-lmo.py               independently verifies a compiled .lmo
```

Strings come from two places: `_()` / `N_()` calls in the JS view, and
the `title` of the LuCI menu entry in
`runtime/usr/share/luci/menu.d/luci-app-filexplorer.json`. The menu
title is translated through this same catalog at runtime, which is why
the sidebar entry reads "Файловый менеджер" under a Russian LuCI.

The compiled catalog is committed at
`runtime/usr/lib/lua/luci/i18n/filexplorer.ru.lmo` and installed to
`/usr/lib/lua/luci/i18n/filexplorer.ru.lmo`. It is committed on purpose:
this stage of the project is deployed by copying files onto a router,
which has neither a compiler nor the LuCI build host tools.

## How LuCI actually resolves a string

Worth knowing before touching anything here, because it constrains what
a valid msgid looks like:

1. The theme's page template loads `/cgi-bin/luci/admin/translations/<lang>`.
2. That endpoint reads every `*.<lang>.lmo` in `/usr/lib/lua/luci/i18n`
   and emits `window.TR = { "<8 hex digits>": "translated text", … }`.
3. In the browser, `_()` (defined in `cbi.js`) computes
   `sfh(trimws(msgid))` and looks the result up in `window.TR`.
   `N_()` does the same with `trimws(msgid) + "\x02" + <plural index>`,
   picking the index via the `Plural-Forms` expression, which is stored
   under key id `00000000`.

### Every package shares one keyspace — beware generic words

`window.TR` is **one flat table built from every `*.<lang>.lmo` in the
directory**, keyed only by the hash of the source string. There is no
per-package namespace, so if two catalogs translate the same msgid
differently, whichever one rpcd happens to read last wins, and the
result is not predictable.

This is not theoretical: 22 of this app's 141 strings also exist in
`luci-base`, and five of them had a different translation there —
including `Mode`, which `luci-base` renders as "Режим работы"
("operating mode", for wireless). That leaked into the permissions
column header on a real router and was both wrong and too long for the
column.

The fix is gettext's message context. In the view:

```js
_('Mode', 'filexplorer')
```

and in the catalog:

```
msgctxt "filexplorer"
msgid "Mode"
msgstr "Права"
```

which changes the lookup key to `filexplorer\x01Mode` and makes it ours
alone. Use a context for any short, generic word whose meaning here
differs from its meaning elsewhere in LuCI. Currently that is `Edit`,
`Image`, `Mode`, `Select` and `up`.

To re-check after adding strings, diff your msgids against LuCI's:

```sh
curl -sO https://raw.githubusercontent.com/openwrt/luci/master/modules/luci-base/po/ru/base.po
# then compare the msgid sets and look for differing msgstr values
```

### Two more consequences of how `_()` builds its key

- **msgids must already be whitespace-normalised.** `trimws()` strips
  the string and collapses internal whitespace runs to one space. A
  msgid with a trailing space or a double space would be hashed
  differently by `po2lmo` than by the browser and would silently never
  match. `po/extract.py` refuses to emit such strings rather than
  producing a catalog that quietly half-works.
- **`Plural-Forms` is evaluated as JavaScript.** The Russian expression
  used here is valid JS as well as valid gettext.

## Adding or updating strings

1. Edit `runtime/www/luci-static/resources/view/filexplorer.js`, wrapping
   user-visible text in `_('…')`, or `N_(n, '…', '…')` when a count is
   involved.
2. Regenerate the template:

   ```sh
   python3 po/extract.py
   ```

3. Add the new msgids to `po/ru/filexplorer.po` (and any other language).
4. Rebuild the catalog — see below.
5. Verify it:

   ```sh
   python3 po/verify-lmo.py po/ru/filexplorer.po \
       runtime/usr/lib/lua/luci/i18n/filexplorer.ru.lmo
   ```

## Rebuilding the .lmo

`.lmo` is LuCI's own binary catalog format, produced by `po2lmo` from
`luci-base`. It is not part of a normal Linux distribution, so build it
from the LuCI sources once:

```sh
git clone --depth 1 https://github.com/openwrt/luci
cd luci/modules/luci-base/src
make po2lmo          # or, if that pulls in too much:
                     # gcc -O2 -o po2lmo po2lmo.c lib/lmo.c
```

Then, from the repository root:

```sh
po2lmo po/ru/filexplorer.po runtime/usr/lib/lua/luci/i18n/filexplorer.ru.lmo
```

`lib/lmo.c` also contains a bison-generated plural-form evaluator that
`po2lmo` itself never calls; if that part fails to build, compiling
`po2lmo.c` against just the `sfh_hash()` function from `lib/lmo.c` is
enough and produces a byte-identical tool.

## Why `verify-lmo.py` exists

`po2lmo` is a build tool that fails quietly: a catalog with wrong keys
is a well-formed file that simply never matches anything, and the UI
just stays English. `verify-lmo.py` reimplements both the hash and the
container format from scratch and checks every message round-trips, so
a broken catalog is caught here rather than on the router.

The current Russian catalog was additionally cross-checked against
LuCI's *own* client-side `sfh()` extracted from `cbi.js` and run under
Node: all 163 keys agree across the C, Python and JavaScript
implementations, which is what guarantees the browser will find them.

## Adding another language

```sh
mkdir -p po/<lang>
cp po/templates/filexplorer.pot po/<lang>/filexplorer.po
# translate, set a correct Plural-Forms header for that language, then:
po2lmo po/<lang>/filexplorer.po \
    runtime/usr/lib/lua/luci/i18n/filexplorer.<lang>.lmo
python3 po/verify-lmo.py po/<lang>/filexplorer.po \
    runtime/usr/lib/lua/luci/i18n/filexplorer.<lang>.lmo
```

Then add the new `.lmo` to `deploy/MANIFEST` so `install.sh` picks it up
and `uninstall.sh` removes it again.
