#!/usr/bin/env python3
"""
Extract translatable strings from the FileXplorer LuCI view into a
gettext .pot template.

LuCI's own build uses xgettext with custom keywords; this project is
deployed by copying files rather than through the OpenWrt build system,
so this small extractor keeps po/templates/filexplorer.pot in sync
without needing the LuCI build host tools.

It recognises the two forms the view actually uses:

    _('single string')
    N_(count, 'singular', 'plural')

Important: the browser-side _() in LuCI's cbi.js normalises the lookup
key with trimws() (strip, then collapse internal whitespace runs to a
single space). Any msgid whose whitespace is not already normalised
would therefore never match at runtime, so this script refuses to emit
such strings and reports them instead.

Usage:  python3 po/extract.py
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.join(ROOT, 'runtime/www/luci-static/resources/view/filexplorer.js')
OUTPUT = os.path.join(HERE, 'templates/filexplorer.pot')

STR = r"'((?:[^'\\]|\\.)*)'"
RE_PLURAL = re.compile(r"N_\(\s*[^,]+,\s*" + STR + r"\s*,\s*" + STR + r"\s*\)")
RE_SINGLE = re.compile(r"(?<![A-Za-z0-9_])_\(\s*" + STR + r"\s*\)")


def unescape_js(s):
    return s.replace("\\'", "'").replace('\\\\', '\\')


def po_escape(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')


def main():
    src = open(SOURCE, encoding='utf-8').read()

    plurals = sorted({(unescape_js(a), unescape_js(b))
                      for a, b in RE_PLURAL.findall(src)})
    plural_singulars = {a for a, _b in plurals}
    singles = sorted({unescape_js(s) for s in RE_SINGLE.findall(src)}
                     - plural_singulars)

    bad = [s for s in singles + [x for p in plurals for x in p]
           if s != ' '.join(s.split())]
    if bad:
        print('Refusing to write: these msgids are not whitespace-normalised,',
              'so the runtime trimws() lookup would never match them:',
              file=sys.stderr)
        for s in bad:
            print('  %r' % s, file=sys.stderr)
        return 1

    out = [
        'msgid ""',
        'msgstr ""',
        '"Content-Type: text/plain; charset=UTF-8\\n"',
        '"Content-Transfer-Encoding: 8bit\\n"',
        '"Project-Id-Version: luci-app-filexplorer\\n"',
        '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
        '',
    ]

    for s in singles:
        out.append('msgid "%s"' % po_escape(s))
        out.append('msgstr ""')
        out.append('')

    for a, b in plurals:
        out.append('msgid "%s"' % po_escape(a))
        out.append('msgid_plural "%s"' % po_escape(b))
        out.append('msgstr[0] ""')
        out.append('msgstr[1] ""')
        out.append('')

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out))

    print('%s: %d singular, %d plural' % (
        os.path.relpath(OUTPUT, ROOT), len(singles), len(plurals)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
