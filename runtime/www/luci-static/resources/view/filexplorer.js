'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

/* ==================================================================
 * FileXplorer - LuCI JS view (two-pane commander)
 *
 * Talks to the "luci.filexplorer" ubus object for every filesystem
 * operation (see /usr/share/rpcd/ucode/filexplorer.uc) and to two
 * plain HTTP endpoints on the Lua controller for streaming upload
 * and download (see /usr/lib/lua/luci/controller/filexplorer.lua).
 *
 * The backend is the sole security boundary: every call below is a
 * convenience for the user, never the reason an operation is allowed.
 * Hiding a button here is UX, not access control.
 *
 * All user-visible strings go through _() / N_() so they can be
 * translated from po/*.po (see po/README.md).
 * ================================================================ */

var callList = rpc.declare({ object: 'luci.filexplorer', method: 'list', params: ['path', 'show_hidden'] });
var callStat = rpc.declare({ object: 'luci.filexplorer', method: 'stat', params: ['path'] });
var callRead = rpc.declare({ object: 'luci.filexplorer', method: 'read', params: ['path', 'mode'] });
var callWrite = rpc.declare({ object: 'luci.filexplorer', method: 'write', params: ['path', 'data', 'encoding', 'expected_mtime', 'expected_size', 'force'] });
var callMkdir = rpc.declare({ object: 'luci.filexplorer', method: 'mkdir', params: ['path'] });
var callCreate = rpc.declare({ object: 'luci.filexplorer', method: 'create', params: ['path'] });
var callRename = rpc.declare({ object: 'luci.filexplorer', method: 'rename', params: ['path', 'name'] });
var callRemove = rpc.declare({ object: 'luci.filexplorer', method: 'remove', params: ['paths'] });
var callCopy = rpc.declare({ object: 'luci.filexplorer', method: 'copy', params: ['items', 'destination', 'overwrite'] });
var callMove = rpc.declare({ object: 'luci.filexplorer', method: 'move', params: ['items', 'destination', 'overwrite'] });
var callChmod = rpc.declare({ object: 'luci.filexplorer', method: 'chmod', params: ['path', 'mode'] });
var callChown = rpc.declare({ object: 'luci.filexplorer', method: 'chown', params: ['path', 'uid', 'gid'] });
var callSearch = rpc.declare({ object: 'luci.filexplorer', method: 'search', params: ['path', 'query', 'recursive', 'max_results'] });
var callDiskInfo = rpc.declare({ object: 'luci.filexplorer', method: 'disk_info', params: ['path'] });
var callDirSize = rpc.declare({ object: 'luci.filexplorer', method: 'dirsize', params: ['path'] });

var LS_PREFIX = 'filexplorer.';

/* ------------------------------------------------------------------
 * small utilities
 * ------------------------------------------------------------------ */

/* The three fixed-width columns, with the CSS variable each one drives
   and the range a drag is allowed to move it through. The minimums are
   what the shortest real value still needs ("42 B", "-rw-r--r--"); the
   maximums only exist so a stray drag cannot squeeze the name column
   down to nothing. */
var COLUMNS = {
	size: { prop: '--fx-w-size', min: 56,  max: 260 },
	time: { prop: '--fx-w-time', min: 70,  max: 340 },
	perm: { prop: '--fx-w-perm', min: 56,  max: 260 }
};

function lsGet(key, def) {
	try {
		var v = window.localStorage.getItem(LS_PREFIX + key);
		return (v === null) ? def : JSON.parse(v);
	} catch (e) {
		return def;
	}
}

function lsSet(key, val) {
	try {
		window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(val));
	} catch (e) { /* ignore quota / privacy-mode errors */ }
}

function fmtSize(n) {
	if (n === null || n === undefined)
		return '—';
	if (n < 1024)
		return _('%d B').format(n);
	var v = n / 1024;
	if (v < 1024)
		return _('%s KiB').format(v.toFixed(v < 10 ? 1 : 0));
	v = v / 1024;
	if (v < 1024)
		return _('%s MiB').format(v.toFixed(v < 10 ? 2 : 1));
	v = v / 1024;
	return _('%s GiB').format(v.toFixed(2));
}

function fmtTime(sec) {
	if (!sec)
		return '—';
	var d = new Date(sec * 1000);
	var p = function (x) { return (x < 10 ? '0' : '') + x; };
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
		' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function b64EncodeUtf8(str) {
	return window.btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(b64) {
	return decodeURIComponent(escape(window.atob(b64)));
}

function joinPath(dir, name) {
	if (dir === '/')
		return '/' + name;
	return dir.replace(/\/+$/, '') + '/' + name;
}

function dirName(p) {
	if (p === '/')
		return '/';
	var idx = p.lastIndexOf('/');
	return (idx <= 0) ? '/' : p.substring(0, idx);
}

var TEXT_EXT = ['txt', 'conf', 'cfg', 'ini', 'json', 'xml', 'html', 'htm', 'css', 'js', 'lua', 'uc', 'sh', 'log', 'uci', 'md', 'yml', 'yaml', 'csv', 'crontab', 'hosts'];
var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
var ARCHIVE_EXT = ['tar', 'gz', 'tgz', 'bz2', 'xz', 'zip', 'ipk', 'apk', '7z', 'rar'];

function extOf(name) {
	var idx = name.lastIndexOf('.');
	return (idx <= 0) ? '' : name.substring(idx + 1).toLowerCase();
}

/* Returns a stable, untranslated type key; label it with typeLabel(). */
function classify(entry) {
	if (entry.type === 'directory') return 'directory';
	if (entry.type === 'link') return 'symlink';
	if (entry.type === 'char' || entry.type === 'block') return 'device';
	if (entry.type === 'fifo') return 'fifo';
	if (entry.type === 'socket') return 'socket';
	var ext = extOf(entry.name);
	if (IMAGE_EXT.indexOf(ext) >= 0) return 'image';
	if (ARCHIVE_EXT.indexOf(ext) >= 0) return 'archive';
	if (TEXT_EXT.indexOf(ext) >= 0) return 'text';
	if (entry.size === 0) return 'text';
	return 'binary';
}

function typeLabel(cls) {
	switch (cls) {
		case 'directory': return _('Directory');
		case 'symlink': return _('Symlink');
		case 'device': return _('Device');
		case 'fifo': return _('FIFO');
		case 'socket': return _('Socket');
		case 'image': return _('Image', 'filexplorer');
		case 'archive': return _('Archive');
		case 'text': return _('Text');
		default: return _('Binary');
	}
}

function iconFor(entry, cls) {
	if (entry.type === 'directory') return '📁';
	if (entry.type === 'link') return entry.broken ? '⚠️' : '🔗';
	if (entry.type === 'char' || entry.type === 'block') return '🔌';
	if (entry.type === 'fifo' || entry.type === 'socket') return '🕳️';
	switch (cls) {
		case 'image': return '🖼️';
		case 'archive': return '📦';
		default: return '📄';
	}
}

function errorMessage(reply, fallback) {
	if (!reply)
		return fallback || _('Unknown error');
	if (reply.error && reply.error.message)
		return reply.error.message;
	return fallback || _('Unknown error');
}

function notifyError(reply, fallback) {
	ui.addNotification(null, E('p', {}, errorMessage(reply, fallback)), 'error');
}

function notifyOk(msg) {
	ui.addNotification(null, E('p', {}, msg), 'info');
}

/* ------------------------------------------------------------------
 * directory picker (used when a copy/move target is edited by hand)
 * ------------------------------------------------------------------ */

function pickDirectory(initialPath) {
	return new Promise(function (resolve) {
		var current = initialPath || '/';
		var listNode = E('div', { class: 'fx-picker-list' });
		var pathInput = E('input', {
			type: 'text', value: current, class: 'cbi-input-text fx-picker-input'
		});

		function renderList(path) {
			listNode.innerHTML = '';
			listNode.appendChild(E('div', { class: 'fx-picker-empty' }, _('Loading…')));
			callList(path, true).then(function (reply) {
				listNode.innerHTML = '';
				if (!reply || reply.ok === false) {
					listNode.appendChild(E('p', { class: 'alert-message warning' }, errorMessage(reply, _('Cannot open directory'))));
					return;
				}
				current = reply.path;
				pathInput.value = current;
				var dirs = reply.entries.filter(function (e) {
					return e.type === 'directory' || (e.type === 'link' && e.target_type === 'directory');
				});
				dirs.sort(function (a, b) { return a.name.localeCompare(b.name); });
				if (reply.parent !== null)
					listNode.appendChild(E('div', { class: 'fx-picker-item', click: function () { renderList(reply.parent); } }, '↑ ..'));
				if (!dirs.length)
					listNode.appendChild(E('div', { class: 'fx-picker-empty' }, _('No subdirectories')));
				dirs.forEach(function (d) {
					listNode.appendChild(E('div', {
						class: 'fx-picker-item',
						click: function () { renderList(joinPath(current, d.name)); }
					}, '📁 ' + d.name));
				});
			});
		}

		pathInput.addEventListener('keydown', function (ev) {
			ev.stopPropagation();
			if (ev.key === 'Enter')
				renderList(pathInput.value);
		});

		ui.showModal(_('Select destination'), [
			pathInput,
			listNode,
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: function () { ui.hideModal(); resolve(null); } }, _('Cancel')),
				' ',
				E('button', {
					class: 'btn cbi-button-action',
					click: function () { ui.hideModal(); resolve(current); }
				}, _('Select this folder'))
			])
		]);

		renderList(current);
	});
}

/* ==================================================================
 * main view
 * ================================================================ */

return view.extend({

	load: function () {
		return Promise.resolve();
	},

	render: function () {
		var self = this;
		this.injectCss();

		this.showHidden = lsGet('showHidden', true);
		this.dirsFirst = lsGet('dirsFirst', true);
		this.rememberPaths = lsGet('rememberPaths', true);
		this.wrapEditor = lsGet('wrapEditor', true);
		this.mobilePane = 'left';

		/* with "remember panel paths" off, both panels open where they
		   always open rather than where they were left */
		this.panes = {
			left: this.makePaneState('left',
				this.rememberPaths ? lsGet('leftPath', '/') : '/'),
			right: this.makePaneState('right',
				this.rememberPaths ? lsGet('rightPath', '/etc') : '/etc')
		};
		this.active = lsGet('activePane', 'left');
		if (this.active !== 'left' && this.active !== 'right')
			this.active = 'left';

		this.root = E('div', { class: 'fx-app' }, [
			this.headerNode = E('div', { class: 'fx-topbar' }),
			this.paneSwitchNode = E('div', { class: 'fx-pane-switch' }),
			this.panesNode = E('div', { class: 'fx-panes' }, [
				this.panes.left.node.root,
				this.panes.right.node.root
			])
		]);

		this.applyColumnWidths();
		this.renderPaneSwitch();
		this.renderHeader();

		this.keyHandler = function (ev) { self.onKeyDown(ev); };
		document.addEventListener('keydown', this.keyHandler);

		this.scheduleLayoutFit();

		this.loadPane('left');
		this.loadPane('right');

		return this.root;
	},

	/* ------------------------------------------------------------------
	 * Give the file manager the room the display actually has.
	 *
	 * Two separate adjustments, both measured rather than assumed:
	 *
	 *   height - stretch the app down to the bottom of the window, so the
	 *            panels show as many rows as fit instead of a fixed guess
	 *            at the theme's header and footer heights.
	 *
	 *   width  - relax the theme's content-width cap, but only when the
	 *            container still fits on screen afterwards. See
	 *            widenContainer() for why that check is not optional.
	 *
	 * The app itself is never moved or resized directly. Earlier versions
	 * did exactly that - width:100vw with a negative margin, then a
	 * position computed from measured geometry - and both shipped a
	 * layout that hung off the edge of the screen on a real router. What
	 * is safe is changing one property of the theme's own container and
	 * letting the theme keep doing its own centring, padding and sidebar
	 * offset.
	 * ------------------------------------------------------------------ */

	scheduleLayoutFit: function () {
		var self = this;
		var run = function () { self.fitLayout(); };

		/* the node is not in the document yet when render() returns */
		window.requestAnimationFrame(run);
		window.setTimeout(run, 100);

		if (!this.resizeHandler) {
			this.resizeHandler = function () {
				if (!self.root || !document.body.contains(self.root)) {
					window.removeEventListener('resize', self.resizeHandler);
					self.resizeHandler = null;
					self.resetContainer();
					return;
				}
				self.fitLayout();
			};
			window.addEventListener('resize', this.resizeHandler);
		}
	},

	contentContainer: function () {
		return (this.root && this.root.closest)
			? this.root.closest('#maincontent')
			: document.getElementById('maincontent');
	},

	/* Relax the theme's content-width cap for this page, but only if the
	   container still fits the window afterwards.
	 *
	 * Themes lay that element out in ways a stylesheet cannot know about
	 * in advance. On Proton2025 it is a flex item that grows into the
	 * space the cap was holding back, so raising the cap simply works and
	 * a 990px column becomes the full window width. A classic sidebar
	 * theme instead combines width:100% with a left margin for the menu,
	 * and there raising the cap pushes the right edge clean off the
	 * screen.
	 *
	 * Rather than trying to recognise the theme, this applies the class,
	 * measures the result, and takes the class straight back off if the
	 * container no longer ends inside the window. A theme this rule does
	 * not suit therefore keeps its own width instead of spilling over.
	 * The check is cheap and idempotent, so it also reruns on resize. */
	widenContainer: function () {
		var host = this.contentContainer();
		if (!host)
			return;

		host.classList.add('fx-wide');

		var vw = document.documentElement.clientWidth;
		var box = host.getBoundingClientRect();
		if (box.right > vw + 1 || box.left < -1)
			host.classList.remove('fx-wide');
	},

	/* On a phone the theme's content container can end up a good deal
	 * narrower than the screen, leaving a band of empty space beside the
	 * file list where it is least affordable.
	 *
	 * Which property causes that differs between themes and between
	 * their own breakpoints - a max-width, an auto margin, a percentage
	 * width, a padding - so this does not try to identify it. It
	 * measures: if the container is leaving more than a small gutter, it
	 * neutralises all four at once, measures again, and puts everything
	 * back if the result is not strictly better and still fully on
	 * screen. A theme this does not suit therefore keeps its own layout,
	 * exactly as with the .fx-wide class.
	 *
	 * Only below the mobile breakpoint. On a desktop the container is
	 * deliberately narrower than the window and .fx-wide already decides
	 * how much of that to take back. */
	stretchContainer: function () {
		var host = this.contentContainer();
		if (!host)
			return;

		var vw = document.documentElement.clientWidth;

		if (vw > 900) {
			this.clearStretch(host);
			return;
		}

		var before = host.getBoundingClientRect();

		/* already using the screen: nothing to do, and nothing to undo */
		if (vw - before.width <= 24) {
			this.clearStretch(host);
			return;
		}

		var saved = {
			maxWidth: host.style.maxWidth,
			width: host.style.width,
			marginLeft: host.style.marginLeft,
			marginRight: host.style.marginRight
		};

		host.style.maxWidth = 'none';
		host.style.width = '100%';
		host.style.marginLeft = '0';
		host.style.marginRight = '0';

		var after = host.getBoundingClientRect();
		var fits = (after.right <= vw + 1 && after.left >= -1 && after.width <= vw + 1);

		if (!fits || after.width <= before.width) {
			host.style.maxWidth = saved.maxWidth;
			host.style.width = saved.width;
			host.style.marginLeft = saved.marginLeft;
			host.style.marginRight = saved.marginRight;
		}
	},

	clearStretch: function (host) {
		host.style.maxWidth = '';
		host.style.width = '';
		host.style.marginLeft = '';
		host.style.marginRight = '';
	},

	/* The container outlives this view, so hand it back untouched. */
	resetContainer: function () {
		var host = this.contentContainer() || document.getElementById('maincontent');
		if (host) {
			host.classList.remove('fx-wide');
			this.clearStretch(host);
		}
	},

	fitLayout: function () {
		var el = this.root;
		if (!el || !document.body.contains(el))
			return;

		this.widenContainer();
		this.stretchContainer();

		/* start from the untouched geometry, so this is idempotent */
		el.style.height = '';

		if (document.documentElement.clientWidth < 1024)
			return;   /* one panel at a time down here; leave the theme alone */

		var top = el.getBoundingClientRect().top;
		el.style.height = Math.max(360,
			Math.round(document.documentElement.clientHeight - top - 16)) + 'px';
	},

	/* view.extend() calls this when navigating away */
	handleReset: null,

	injectCss: function () {
		if (document.getElementById('filexplorer-css'))
			return;
		document.head.appendChild(E('link', {
			id: 'filexplorer-css',
			rel: 'stylesheet',
			href: L.resource('filexplorer/filexplorer.css')
		}));
	},

	/* ---------------------------------------------------- pane state */

	makePaneState: function (id, path) {
		var self = this;
		var head = E('div', { class: 'fx-pane-head' });
		var body = E('div', {
			class: 'fx-pane-body',
			/* the rows stop their own contextmenu event, so anything that
			   reaches here was a right-click on empty space: same menu,
			   without the per-file entries */
			contextmenu: function (ev) {
				ev.preventDefault();
				self.setActive(id);
				self.showContextMenu(ev, id, null);
			}
		});
		var foot = E('div', { class: 'fx-pane-foot' });
		var root = E('div', {
			class: 'fx-pane',
			click: function () { self.setActive(id); }
		}, [head, body, foot]);

		return {
			id: id,
			path: path || '/',
			parent: null,
			entries: [],
			selected: {},
			/* directory sizes, keyed by path, filled in only by an
			   explicit "calculate size" - see actCalcSize() */
			dirSizes: {},
			cursor: 0,
			visible: [],
			sortKey: lsGet(id + 'SortKey', 'name'),
			sortDir: lsGet(id + 'SortDir', 'asc'),
			disk: null,
			node: { root: root, head: head, body: body, foot: foot }
		};
	},

	other: function (id) {
		return (id === 'left') ? 'right' : 'left';
	},

	activePane: function () {
		return this.panes[this.active];
	},

	setActive: function (id) {
		if (this.active === id)
			return;
		this.active = id;
		lsSet('activePane', id);
		this.renderPaneChrome('left');
		this.renderPaneChrome('right');
		this.renderPaneSwitch();
		this.renderHeader();
	},

	renderPaneChrome: function (id) {
		var p = this.panes[id];
		p.node.root.classList.toggle('fx-pane-active', this.active === id);
		p.node.root.classList.toggle('fx-pane-shown', this.mobilePane === id);
	},

	/* page heading + the actions that are not per-file */
	/* Upload and download are the one pair in the header that has to read
	   as a matched set: same tray, arrow mirrored. No emoji pair does
	   that - the outbox/inbox trays differ only by a small arrow and read
	   as the same icon twice - so these two are drawn instead. Inline
	   markup, no icon library, and the strokes take the button's own
	   colour so both themes are handled without a second palette. */
	trayIcon: function (dir) {
		var NS = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(NS, 'svg');

		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('class', 'fx-act-svg');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');

		var up = (dir === 'up');
		var paths = [
			/* the tray, identical for both */
			'M4.75 15.25v2.25a2.5 2.5 0 0 0 2.5 2.5h9.5a2.5 2.5 0 0 0 2.5-2.5v-2.25',
			/* shaft */
			up ? 'M12 15.5V4.25' : 'M12 4.25V15.5',
			/* head */
			up ? 'M7.75 8.5 12 4.25l4.25 4.25' : 'M7.75 11.25 12 15.5l4.25-4.25'
		];

		for (var i = 0; i < paths.length; i++) {
			var el = document.createElementNS(NS, 'path');
			el.setAttribute('d', paths[i]);
			/* the arrow is the part that carries the meaning, so it is the
			   part that gets the accent colour */
			if (i > 0)
				el.setAttribute('class', 'fx-act-svg-arrow');
			svg.appendChild(el);
		}

		return svg;
	},

	renderHeader: function () {
		var self = this;
		var p = this.activePane();
		/* Explicit marks only, not targetEntries(): that one falls back to
		   the row under the cursor so an action always has something to
		   work on, which would make this counter read "1 selected" for
		   ever. It reports what the user marked, like the panel footer. */
		var n = p ? this.selectedEntries(p).length : 0;

		/* One icon button. The label lives in the tooltip and in the
		   shortcuts dialog: spelling every action out here would not fit
		   one row on a router's content column, and for a commander the
		   F-key is the label anyway. */
		function act(icon, key, label, fn, cls) {
			return E('button', {
				class: 'btn cbi-button fx-act' + (cls ? ' ' + cls : ''),
				title: key ? (label + ' (' + key + ')') : label,
				'aria-label': label,
				click: ui.createHandlerFn(self, function () { fn(); })
			}, [
				E('span', { class: 'fx-act-ico' }, icon),
				key ? E('span', { class: 'fx-act-key' }, key) : ''
			]);
		}

		function sep() {
			return E('span', { class: 'fx-sep' });
		}

		dom.content(this.headerNode, [
			/* same string as the menu entry, so the page is titled the
			   way the user got here */
			E('h2', { class: 'fx-title' }, _('FileXplorer')),
			sep(),

			act('\ud83d\udc41\ufe0f', 'F3', _('View'), function () { self.actF3(); }),
			act('\ud83d\udcdd', 'F4', _('Edit', 'filexplorer'), function () { self.actF4(); }),
			act('\ud83d\udccb', 'F5', _('Copy'), function () { self.actF5(); }),
			act('\u27a1\ufe0f', 'F6', _('Move'), function () { self.actF6(); }),
			act('\ud83d\udcc2', 'F7', _('New folder'), function () { self.actF7(); }),
			act('\ud83c\udff7\ufe0f', 'F2', _('Rename'), function () { self.actF2(); }),
			act('\ud83d\uddd1\ufe0f', 'F8', _('Delete'), function () { self.actF8(); }, 'cbi-button-remove fx-act-danger'),
			sep(),

			act('\ud83d\udcc4', '', _('New file'), function () { self.actNewFile(); }),
			act(self.trayIcon('up'), '', _('Upload'), function () { self.actUpload(); }),
			act(self.trayIcon('down'), '', _('Download'), function () { self.actDownload(); }),
			act('\ud83d\udd0d', '', _('Search'), function () { self.actSearch(); }),

			E('span', { class: 'fx-fn-spacer' }),
			n ? E('span', { class: 'fx-fn-count' },
				N_(n, '%d selected', '%d selected').format(n)) : '',
			/* U+2328 without the emoji variation selector: with it the
			   keyboard renders washed-out and nearly invisible on a dark
			   theme, without it as a crisp glyph */
			act('\u2328', '', _('Keyboard shortcuts'), function () { self.actShortcuts(); }),
			act('\u2699\ufe0f', '', _('Settings'), function () { self.actSettings(); })
		]);
	},

	renderPaneSwitch: function () {
		var self = this;
		function tab(id, label) {
			return E('button', {
				class: 'btn fx-switch-btn' + (self.mobilePane === id ? ' fx-switch-active' : ''),
				click: function () {
					self.mobilePane = id;
					self.setActive(id);
					self.renderPaneChrome('left');
					self.renderPaneChrome('right');
					self.renderPaneSwitch();
				}
			}, label);
		}
		dom.content(this.paneSwitchNode, [
			tab('left', _('Left panel')),
			tab('right', _('Right panel'))
		]);
	},

	/* ------------------------------------------------------ loading */

	loadPane: function (id, keepCursor) {
		var self = this;
		var p = this.panes[id];
		dom.content(p.node.body, E('div', { class: 'fx-loading' }, _('Loading…')));

		return callList(p.path, true).then(function (reply) {
			if (!reply || reply.ok === false) {
				notifyError(reply, _('Cannot open directory'));
				if (p.path !== '/') {
					p.path = '/';
					return self.loadPane(id);
				}
				dom.content(p.node.body, E('div', { class: 'fx-loading' }, errorMessage(reply, _('Cannot open directory'))));
				return;
			}
			p.path = reply.path;
			p.parent = reply.parent;
			p.entries = reply.entries;
			p.selected = {};
			p.dirSizes = {};
			if (!keepCursor)
				p.cursor = 0;
			if (self.rememberPaths)
				lsSet(id + 'Path', p.path);
			self.renderPane(id);
			self.loadDisk(id);
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, _('Request failed: %s').format(err.message || err)), 'error');
		});
	},

	loadDisk: function (id) {
		var self = this;
		var p = this.panes[id];
		callDiskInfo(p.path).then(function (reply) {
			p.disk = (reply && reply.ok !== false) ? reply : null;
			self.renderFoot(id);
		}).catch(function () { /* non-critical */ });
	},

	navigate: function (id, path) {
		var p = this.panes[id];
		p.path = path;
		return this.loadPane(id);
	},

	refreshAll: function () {
		this.loadPane('left', true);
		this.loadPane('right', true);
	},

	/* ------------------------------------------------------ rendering */

	sortedEntries: function (p) {
		var self = this;
		var list = p.entries.filter(function (e) { return self.showHidden || !e.hidden; });
		var key = p.sortKey, dir = (p.sortDir === 'asc') ? 1 : -1;
		list.sort(function (a, b) {
			if (self.dirsFirst) {
				var ad = (a.type === 'directory'), bd = (b.type === 'directory');
				if (ad !== bd) return ad ? -1 : 1;
			}
			var av, bv;
			if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
			else if (key === 'type') { av = classify(a); bv = classify(b); }
			else { av = a[key]; bv = b[key]; }
			if (av < bv) return -1 * dir;
			if (av > bv) return 1 * dir;
			return 0;
		});
		return list;
	},

	selectedEntries: function (p) {
		return p.entries.filter(function (e) { return p.selected[e.path]; });
	},

	/* entries the next action applies to: explicit selection, else the
	   row under the cursor - classic commander behaviour */
	targetEntries: function (p) {
		var sel = this.selectedEntries(p);
		if (sel.length)
			return sel;
		var cur = p.visible[p.cursor];
		return cur ? [cur] : [];
	},

	renderPane: function (id) {
		this.renderHead(id);
		this.renderBody(id);
		this.renderFoot(id);
		this.renderPaneChrome(id);
		this.renderHeader();
	},

	renderHead: function (id) {
		var self = this;
		var p = this.panes[id];

		var input = E('input', {
			type: 'text', class: 'cbi-input-text fx-path-input', value: p.path,
			title: _('Type a path and press Enter')
		});
		input.addEventListener('keydown', function (ev) {
			ev.stopPropagation();
			if (ev.key === 'Enter')
				self.navigate(id, input.value);
			else if (ev.key === 'Escape')
				input.value = p.path;
		});
		input.addEventListener('focus', function () { self.setActive(id); });

		var crumbs = E('div', { class: 'fx-crumbs' });
		crumbs.appendChild(E('span', {
			class: 'fx-crumb', title: _('Root directory'),
			click: function () { self.navigate(id, '/'); }
		}, '/'));
		var acc = '';
		var parts = (p.path === '/') ? [] : p.path.split('/').filter(Boolean);
		parts.forEach(function (part, i) {
			acc = joinPath(acc || '/', part);
			var target = acc;
			if (i > 0)
				crumbs.appendChild(E('span', { class: 'fx-crumb-sep' }, '›'));
			crumbs.appendChild(E('span', {
				class: 'fx-crumb' + (i === parts.length - 1 ? ' fx-crumb-last' : ''),
				click: function () { self.navigate(id, target); }
			}, part));
		});

		dom.content(p.node.head, [
			E('div', { class: 'fx-head-row' }, [
				E('button', {
					class: 'btn fx-icon-btn', title: _('Up one level'),
					disabled: p.parent ? null : true,
					click: function (ev) {
						ev.stopPropagation();
						if (p.parent) self.navigate(id, p.parent);
					}
				}, '↑'),
				input,
				E('button', {
					class: 'btn fx-icon-btn', title: _('Refresh'),
					click: function (ev) { ev.stopPropagation(); self.loadPane(id, true); }
				}, '↻')
			]),
			crumbs
		]);
	},

	/* ------------------------------------------- resizable columns */

	/* Widths live as variables on the app root, so one drag moves the
	   matching column in both panes and every row follows without being
	   re-rendered. An unset variable means "use the CSS default". */
	applyColumnWidths: function () {
		if (!this.root)
			return;
		for (var key in COLUMNS) {
			var px = lsGet('col_' + key, null);
			if (typeof px === 'number' && px > 0)
				this.root.style.setProperty(COLUMNS[key].prop, Math.round(px) + 'px');
			else
				this.root.style.removeProperty(COLUMNS[key].prop);
		}
	},

	resetColumnWidth: function (key) {
		lsSet('col_' + key, null);
		this.root.style.removeProperty(COLUMNS[key].prop);
	},

	/* The handle sits on the *left* edge of the column it resizes, so
	   dragging left widens that column and gives the name column back the
	   difference. Pointer events rather than mouse events, so a touch
	   drag works too, and the pointer is captured so the drag survives
	   leaving the handle. */
	startColumnResize: function (ev, key, cell) {
		var self = this;
		var meta = COLUMNS[key];
		if (!meta || ev.button > 0)
			return;

		ev.preventDefault();
		ev.stopPropagation();

		var startX = ev.clientX;
		var startW = cell.getBoundingClientRect().width;
		var target = ev.currentTarget;

		document.body.classList.add('fx-resizing');
		try { target.setPointerCapture(ev.pointerId); } catch (e) { /* older browsers */ }

		function move(e) {
			var w = Math.round(startW + (startX - e.clientX));
			w = Math.max(meta.min, Math.min(meta.max, w));
			self.root.style.setProperty(meta.prop, w + 'px');
		}

		function done(e) {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', done);
			target.removeEventListener('pointercancel', done);
			document.body.classList.remove('fx-resizing');
			try { target.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ }

			var v = self.root.style.getPropertyValue(meta.prop);
			var px = parseInt(v, 10);
			if (px > 0)
				lsSet('col_' + key, px);
		}

		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', done);
		target.addEventListener('pointercancel', done);
	},

	renderBody: function (id) {
		var self = this;
		var p = this.panes[id];
		var list = this.sortedEntries(p);
		p.visible = list;
		if (p.cursor >= list.length)
			p.cursor = Math.max(0, list.length - 1);

		/* `resize` names the column this header can be dragged to resize;
		   omitted for the name column, which is the one that absorbs
		   whatever the others give up. */
		function sortHeader(label, key, cls, resize) {
			var arrow = (p.sortKey === key) ? (p.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
			var cell = E('div', {
				class: 'fx-cell fx-th ' + cls,
				click: function (ev) {
					ev.stopPropagation();
					self.setActive(id);
					if (p.sortKey === key)
						p.sortDir = (p.sortDir === 'asc') ? 'desc' : 'asc';
					else { p.sortKey = key; p.sortDir = 'asc'; }
					lsSet(id + 'SortKey', p.sortKey);
					lsSet(id + 'SortDir', p.sortDir);
					self.renderBody(id);
				}
			}, label + arrow);

			if (resize) {
				cell.appendChild(E('span', {
					class: 'fx-resizer',
					title: _('Drag to resize, double-click to reset'),
					pointerdown: function (ev) { self.startColumnResize(ev, resize, cell); },
					/* the handle lives inside the sort header, so both of
					   these have to stop here or a resize would also sort */
					click: function (ev) { ev.stopPropagation(); },
					dblclick: function (ev) {
						ev.stopPropagation();
						self.resetColumnWidth(resize);
					}
				}));
			}

			return cell;
		}

		var rows = [
			E('div', { class: 'fx-row fx-header' }, [
				E('div', { class: 'fx-cell fx-c-mark' }, ''),
				sortHeader(_('Name'), 'name', 'fx-c-name'),
				sortHeader(_('Size'), 'size', 'fx-c-size', 'size'),
				sortHeader(_('Modified'), 'mtime', 'fx-c-time', 'time'),
				/* short label on purpose: this column shows the mode string
				   (-rw-r--r--), and the full word does not fit a half-width
				   panel once translated */
				sortHeader(_('Mode', 'filexplorer'), 'mode_octal', 'fx-c-perm', 'perm')
			])
		];

		if (p.parent) {
			rows.push(E('div', {
				class: 'fx-row fx-updir',
				dblclick: function () { self.navigate(id, p.parent); },
				click: function (ev) { ev.stopPropagation(); self.setActive(id); self.navigate(id, p.parent); }
			}, [
				E('div', { class: 'fx-cell fx-c-mark' }, ''),
				E('div', { class: 'fx-cell fx-c-name' }, '↑ ..'),
				E('div', { class: 'fx-cell fx-c-size' }, _('up', 'filexplorer')),
				E('div', { class: 'fx-cell fx-c-time' }, ''),
				E('div', { class: 'fx-cell fx-c-perm' }, '')
			]));
		}

		if (!list.length) {
			rows.push(E('div', { class: 'fx-empty' }, _('This directory is empty')));
		}

		list.forEach(function (entry, idx) {
			rows.push(self.renderRow(id, entry, idx));
		});

		dom.content(p.node.body, rows);
		this.scrollCursorIntoView(id);
	},

	renderRow: function (id, entry, idx) {
		var self = this;
		var p = this.panes[id];
		var cls = classify(entry);
		var isSel = !!p.selected[entry.path];
		var isCur = (p.cursor === idx);

		/* A directory has no size of its own - the number people want is
		   the sum of its whole subtree, which costs a full walk. So the
		   column shows the type until someone asks for the total, and
		   the answer replaces it once it arrives. */
		var sizeInfo = (entry.type === 'directory') ? p.dirSizes[entry.path] : null;
		var sizeText, sizeTitle = '';

		var sizeClass = '';

		if (entry.type !== 'directory') {
			sizeText = fmtSize(entry.size);
		}
		else if (!sizeInfo) {
			/* the same dash fmtSize() uses for a size that is not known,
			   because that is exactly what this is - the column says
			   nothing rather than saying something that is not a size */
			sizeText = '—';
			sizeTitle = _('Ctrl+Space calculates the size of this folder');
		}
		else if (sizeInfo.pending) {
			sizeText = '…';
			sizeClass = ' fx-size-busy';
			sizeTitle = _('Calculating…');
		}
		else if (sizeInfo.failed) {
			/* back to the dash, but coloured: otherwise a failed walk is
			   indistinguishable from one that was never asked for */
			sizeText = '—';
			sizeClass = ' fx-size-failed';
			sizeTitle = sizeInfo.failed;
		}
		else {
			/* a capped walk gives a lower bound, and says so rather than
			   presenting a partial total as the answer */
			sizeText = (sizeInfo.truncated ? '>' : '') + fmtSize(sizeInfo.size);
			sizeTitle = sizeInfo.truncated
				? _('At least %s: the folder is too large to measure in full.').format(fmtSize(sizeInfo.size))
				: N_(sizeInfo.files, '%d file', '%d files').format(sizeInfo.files);
		}

		var mark = E('span', {
			class: 'fx-mark' + (isSel ? ' fx-mark-on' : ''),
			title: _('Select', 'filexplorer'),
			click: function (ev) {
				ev.stopPropagation();
				self.setActive(id);
				self.toggleSelect(id, entry);
				/* redraw: the box glyph, the row highlight, the footer
				   total and the toolbar counter all follow this */
				self.renderBody(id);
				self.renderFoot(id);
				self.renderHeader();
			}
		}, isSel ? '■' : '□');

		var nameText = entry.name;
		if (entry.is_symlink)
			nameText += ' → ' + (entry.symlink_target || '?');

		var row = E('div', {
			class: 'fx-row fx-item' +
				(isSel ? ' fx-selected' : '') +
				(isCur ? ' fx-cursor' : '') +
				(entry.hidden ? ' fx-hidden-item' : '') +
				(entry.broken ? ' fx-broken' : ''),
			click: function (ev) {
				ev.stopPropagation();
				self.setActive(id);
				p.cursor = idx;
				self.renderBody(id);
				self.renderFoot(id);
			},
			dblclick: function (ev) {
				ev.stopPropagation();
				self.setActive(id);
				p.cursor = idx;
				self.openEntry(id, entry);
			},
			contextmenu: function (ev) {
				ev.preventDefault();
				ev.stopPropagation();
				self.setActive(id);
				p.cursor = idx;
				self.renderBody(id);
				self.showContextMenu(ev, id, entry);
			}
		}, [
			E('div', { class: 'fx-cell fx-c-mark' }, mark),
			E('div', { class: 'fx-cell fx-c-name', title: entry.name }, [
				E('span', { class: 'fx-ico' }, iconFor(entry, cls)),
				E('span', { class: 'fx-nm' }, nameText)
			]),
			E('div', { class: 'fx-cell fx-c-size' + sizeClass, title: sizeTitle }, sizeText),
			E('div', { class: 'fx-cell fx-c-time' }, fmtTime(entry.mtime)),
			E('div', { class: 'fx-cell fx-c-perm' }, entry.mode_string)
		]);

		return row;
	},

	renderFoot: function (id) {
		var p = this.panes[id];
		var sel = this.selectedEntries(p);
		var bytes = 0;
		sel.forEach(function (e) { if (e.type !== 'directory') bytes += e.size; });

		var left = sel.length
			? E('span', { class: 'fx-foot-sel' },
				N_(sel.length, '%d item selected', '%d items selected').format(sel.length) +
				(bytes > 0 ? ' · ' + fmtSize(bytes) : ''))
			: E('span', {}, N_(p.visible.length, '%d item', '%d items').format(p.visible.length));

		var right = p.disk
			? E('span', { class: 'fx-foot-disk', title: p.disk.filesystem + ' (' + p.disk.fstype + ')' },
				_('%s free of %s').format(fmtSize(p.disk.free), fmtSize(p.disk.total)))
			: E('span', {}, '');

		dom.content(p.node.foot, [left, right]);
	},

	scrollCursorIntoView: function (id) {
		var p = this.panes[id];
		var el = p.node.body.querySelector('.fx-cursor');
		if (el && el.scrollIntoView)
			el.scrollIntoView({ block: 'nearest' });
	},

	/* -------------------------------------------------- function bar */


	/* ---------------------------------------------------- keyboard */

	onKeyDown: function (ev) {
		/* never hijack typing in a field or while a modal is open */
		var t = ev.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
			return;
		if (document.querySelector('body.modal-overlay-active, .modal'))
			return;
		if (!this.root || !document.body.contains(this.root))
			return;

		var id = this.active;
		var p = this.panes[id];
		var handled = true;

		switch (ev.key) {
			case 'Tab':
				this.mobilePane = this.other(id);
				this.setActive(this.other(id));
				this.renderPaneChrome('left');
				this.renderPaneChrome('right');
				this.renderPaneSwitch();
				break;
			case 'ArrowDown':
				p.cursor = Math.min(p.cursor + 1, p.visible.length - 1);
				this.renderBody(id); this.renderFoot(id); this.renderHeader();
				break;
			case 'ArrowUp':
				p.cursor = Math.max(p.cursor - 1, 0);
				this.renderBody(id); this.renderFoot(id); this.renderHeader();
				break;
			case 'PageDown':
				p.cursor = Math.min(p.cursor + 10, p.visible.length - 1);
				this.renderBody(id); this.renderHeader();
				break;
			case 'PageUp':
				p.cursor = Math.max(p.cursor - 10, 0);
				this.renderBody(id); this.renderHeader();
				break;
			case 'Home':
				p.cursor = 0; this.renderBody(id); this.renderHeader();
				break;
			case 'End':
				p.cursor = Math.max(0, p.visible.length - 1);
				this.renderBody(id); this.renderHeader();
				break;
			case 'Enter':
				if (p.visible[p.cursor]) this.openEntry(id, p.visible[p.cursor]);
				break;
			case 'Backspace':
				if (p.parent) this.navigate(id, p.parent);
				break;
			case 'Insert':
			case ' ':
				/* Ctrl+Space is "calculate this folder's size", as in
				   Midnight Commander; plain Space marks the row */
				if (ev.key === ' ' && (ev.ctrlKey || ev.metaKey)) {
					this.actCalcSize();
				}
				else if (p.visible[p.cursor]) {
					this.toggleSelect(id, p.visible[p.cursor]);
					p.cursor = Math.min(p.cursor + 1, p.visible.length - 1);
					this.renderBody(id); this.renderFoot(id); this.renderHeader();
				}
				break;
			case 'F2': this.actF2(); break;
			case 'F3': this.actF3(); break;
			case 'F4': this.actF4(); break;
			case 'F5': this.actF5(); break;
			case 'F6': this.actF6(); break;
			case 'F7': this.actF7(); break;
			case 'F8':
			case 'Delete': this.actF8(); break;
			case 'a':
			case 'A':
				if (ev.ctrlKey || ev.metaKey) {
					/* toggles: a second Ctrl+A clears again */
					if (this.selectedEntries(p).length === p.visible.length)
						this.clearSelection(id);
					else
						this.selectAll(id);
				} else handled = false;
				break;
			case 'r':
			case 'R':
				if (ev.ctrlKey || ev.metaKey) this.loadPane(id, true);
				else handled = false;
				break;
			default:
				handled = false;
		}

		if (handled) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	},

	selectAll: function (id) {
		var p = this.panes[id];
		p.selected = {};
		p.visible.forEach(function (e) { p.selected[e.path] = true; });
		this.renderBody(id); this.renderFoot(id); this.renderHeader();
	},

	clearSelection: function (id) {
		this.panes[id].selected = {};
		this.renderBody(id); this.renderFoot(id); this.renderHeader();
	},

	toggleSelect: function (id, entry) {
		var p = this.panes[id];
		if (p.selected[entry.path])
			delete p.selected[entry.path];
		else
			p.selected[entry.path] = true;
	},

	openEntry: function (id, entry) {
		if (entry.type === 'directory' || (entry.type === 'link' && entry.target_type === 'directory')) {
			this.navigate(id, entry.path);
			return;
		}
		if (entry.type === 'link' && entry.broken) {
			ui.addNotification(null, E('p', {}, _('Broken symlink: %s').format(entry.symlink_target || '?')), 'warning');
			return;
		}
		this.previewEntry(entry);
	},

	/* ------------------------------------------------ context menu */

	/* One menu builder for both cases: right-clicking a row, and
	   right-clicking the empty space below the rows (entry === null).
	   Everything that can be reached from the header or the keyboard is
	   reachable here too, so the menu is a complete alternative to both.

	   Which entries an action applies to follows the same rule as the
	   function keys: an explicit selection wins, and the clicked row is
	   used only when nothing is marked. Right-clicking a row outside the
	   selection moves the cursor there and acts on that row alone, which
	   is what makes "select three, right-click one of them, Delete" mean
	   all three rather than one. */
	showContextMenu: function (ev, id, entry) {
		var self = this;
		this.closeContextMenu();

		var p = this.panes[id];
		var sel = this.selectedEntries(p);
		var targets = (entry && sel.length && p.selected[entry.path]) ? sel
		            : (entry ? [entry] : sel);
		var many = targets.length > 1;
		var one = (targets.length === 1) ? targets[0] : null;
		var isDir = !!(one && one.type === 'directory');
		var SEP = null;

		var items = [];

		if (one) {
			items.push([_('Open'), 'Enter', function () { self.openEntry(id, one); }]);
			if (!isDir) {
				items.push([_('View'), 'F3', function () { self.previewEntry(one); }]);
				items.push([_('Edit', 'filexplorer'), 'F4', function () { self.editEntry(one); }]);
				items.push([_('Download'), '', function () { self.downloadEntry(one); }]);
			}
			items.push(SEP);
		}

		if (targets.length) {
			var label = many ? N_(targets.length, '%d item', '%d items').format(targets.length) : '';
			items.push([_('Copy') + (label ? ' \u2014 ' + label : ''), 'F5',
				function () { self.copyOrMove('copy', id, targets); }]);
			items.push([_('Move') + (label ? ' \u2014 ' + label : ''), 'F6',
				function () { self.copyOrMove('move', id, targets); }]);
			if (one)
				items.push([_('Rename'), 'F2', function () { self.renameEntry(id, one); }]);
			items.push([_('Delete') + (label ? ' \u2014 ' + label : ''), 'F8',
				function () { self.deleteEntries(id, targets); }, 'fx-ctx-danger']);
			items.push(SEP);
		}

		if (targets.some(function (t) { return t.type === 'directory'; })) {
			items.push([_('Calculate size'), 'Ctrl+Space', function () {
				self.setActive(id);
				self.actCalcSize();
			}]);
			items.push(SEP);
		}

		if (entry) {
			items.push([p.selected[entry.path] ? _('Unselect') : _('Select', 'filexplorer'), 'Space',
				function () {
					self.toggleSelect(id, entry);
					self.renderBody(id); self.renderFoot(id); self.renderHeader();
				}]);
		}
		items.push([_('Select all'), 'Ctrl+A', function () { self.selectAll(id); }]);
		if (sel.length)
			items.push([_('Clear selection', 'filexplorer'), '', function () { self.clearSelection(id); }]);
		items.push(SEP);

		items.push([_('New file'), '', function () { self.setActive(id); self.newFile(); }]);
		items.push([_('New folder'), 'F7', function () { self.setActive(id); self.newDirectory(); }]);
		items.push([_('Upload'), '', function () { self.setActive(id); self.actUpload(); }]);
		items.push(SEP);

		if (one && one.type !== 'link')
			items.push([_('Permissions'), '', function () { self.permissionsEntry(id, one); }]);
		if (one)
			items.push([_('Properties'), '', function () { self.propertiesEntry(one); }]);
		items.push([_('Search'), '', function () { self.setActive(id); self.actSearch(); }]);
		items.push([_('Refresh'), 'Ctrl+R', function () { self.loadPane(id); }]);

		/* drop a separator that ended up first, last, or next to another */
		var clean = [];
		items.forEach(function (it) {
			if (it === SEP) {
				if (clean.length && clean[clean.length - 1] !== SEP)
					clean.push(SEP);
			} else {
				clean.push(it);
			}
		});
		while (clean.length && clean[clean.length - 1] === SEP)
			clean.pop();

		var menu = E('div', { class: 'fx-ctx' }, clean.map(function (it) {
			if (it === SEP)
				return E('div', { class: 'fx-ctx-sep' });
			return E('div', {
				class: 'fx-ctx-item' + (it[3] ? ' ' + it[3] : ''),
				click: function () { self.closeContextMenu(); it[2](); }
			}, [
				E('span', { class: 'fx-ctx-label' }, it[0]),
				E('span', { class: 'fx-ctx-key' }, it[1] || '')
			]);
		}));

		menu.style.left = ev.clientX + 'px';
		menu.style.top = ev.clientY + 'px';
		document.body.appendChild(menu);

		var r = menu.getBoundingClientRect();
		if (r.right > window.innerWidth)
			menu.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
		if (r.bottom > window.innerHeight)
			menu.style.top = Math.max(0, window.innerHeight - r.height - 8) + 'px';

		this._ctx = menu;
		this._ctxClose = function (e) { if (!menu.contains(e.target)) self.closeContextMenu(); };
		window.setTimeout(function () {
			document.addEventListener('click', self._ctxClose);
			document.addEventListener('contextmenu', self._ctxClose);
		}, 0);
	},

	closeContextMenu: function () {
		if (this._ctx) { this._ctx.remove(); this._ctx = null; }
		if (this._ctxClose) {
			document.removeEventListener('click', this._ctxClose);
			document.removeEventListener('contextmenu', this._ctxClose);
			this._ctxClose = null;
		}
	},

	/* --------------------------------------------- function actions */

	actF2: function () {
		var id = this.active, p = this.panes[id];
		var t = this.targetEntries(p);
		if (t.length === 1) this.renameEntry(id, t[0]);
		else if (t.length) ui.addNotification(null, E('p', {}, _('Select exactly one item to rename.')), 'warning');
	},

	actF3: function () {
		var t = this.targetEntries(this.activePane());
		if (t.length === 1 && t[0].type !== 'directory') this.previewEntry(t[0]);
	},

	actF4: function () {
		var t = this.targetEntries(this.activePane());
		if (t.length === 1 && t[0].type !== 'directory') this.editEntry(t[0]);
	},

	actF5: function () {
		var id = this.active;
		this.copyOrMove('copy', id, this.targetEntries(this.panes[id]));
	},

	actF6: function () {
		var id = this.active;
		this.copyOrMove('move', id, this.targetEntries(this.panes[id]));
	},

	actF7: function () { this.newDirectory(); },

	actF8: function () {
		var id = this.active;
		this.deleteEntries(id, this.targetEntries(this.panes[id]));
	},

	/* Midnight Commander puts this on Ctrl+Space and so does this: it is
	   the one action a two-pane manager needs that no toolbar button can
	   sensibly own, because it is per-folder and takes real time. Runs
	   over the marked folders, or the one under the cursor. */
	actCalcSize: function () {
		var self = this;
		var id = this.active, p = this.panes[id];
		var dirs = this.targetEntries(p).filter(function (e) {
			return e.type === 'directory';
		});

		if (!dirs.length) {
			ui.addNotification(null, E('p', {},
				_('Select a folder to calculate its size.')), 'warning');
			return;
		}

		dirs.forEach(function (d) { p.dirSizes[d.path] = { pending: true }; });
		this.renderBody(id);

		/* one at a time: each of these walks a subtree, and firing them
		   all at once would have a router's rpcd running several full
		   filesystem walks in parallel */
		var next = function (i) {
			if (i >= dirs.length)
				return;
			var d = dirs[i];
			return callDirSize(d.path).then(function (r) {
				if (!r || r.ok === false) {
					p.dirSizes[d.path] = {
						failed: errorMessage(r, _('Cannot read properties'))
					};
				} else {
					p.dirSizes[d.path] = {
						size: r.size,
						files: r.files,
						dirs: r.dirs,
						truncated: !!r.truncated
					};
				}
				self.renderBody(id);
				return next(i + 1);
			}).catch(function (err) {
				p.dirSizes[d.path] = { failed: err.message || String(err) };
				self.renderBody(id);
				return next(i + 1);
			});
		};
		next(0);
	},

	actNewFile: function () { this.newFile(); },

	actDownload: function () {
		var t = this.targetEntries(this.activePane());
		if (t.length === 1 && t[0].type !== 'directory') this.downloadEntry(t[0]);
		else if (t.length) ui.addNotification(null, E('p', {}, _('Select exactly one file to download.')), 'warning');
	},

	/* ------------------------------------------------ create/rename */

	validateName: function (name) {
		if (!name || !name.length) return _('Name cannot be empty');
		if (name === '.' || name === '..') return _('Invalid name');
		if (name.indexOf('/') >= 0) return _('Name cannot contain a slash');
		if (name.length > 255) return _('Name is too long');
		return null;
	},

	promptName: function (title, initial, okLabel) {
		var self = this;
		return new Promise(function (resolve) {
			var input = E('input', { type: 'text', class: 'cbi-input-text fx-full', value: initial || '' });
			var err = E('div', { class: 'fx-form-error' });
			function submit() {
				var e = self.validateName(input.value);
				if (e) { err.textContent = e; return; }
				ui.hideModal();
				resolve(input.value);
			}
			input.addEventListener('keydown', function (ev) {
				ev.stopPropagation();
				if (ev.key === 'Enter') submit();
			});
			ui.showModal(title, [
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, _('Name')),
					input
				]),
				err,
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: function () { ui.hideModal(); resolve(null); } }, _('Cancel')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: submit }, okLabel || _('Create'))
				])
			]);
			input.focus();
			input.select();
		});
	},

	newFile: function () {
		var self = this, id = this.active, p = this.panes[id];
		this.promptName(_('New file'), '').then(function (name) {
			if (!name) return;
			callCreate(joinPath(p.path, name)).then(function (r) {
				if (!r || r.ok === false) return notifyError(r, _('Cannot create file'));
				notifyOk(_('File created'));
				self.loadPane(id, true);
			});
		});
	},

	newDirectory: function () {
		var self = this, id = this.active, p = this.panes[id];
		this.promptName(_('New folder'), '').then(function (name) {
			if (!name) return;
			callMkdir(joinPath(p.path, name)).then(function (r) {
				if (!r || r.ok === false) return notifyError(r, _('Cannot create folder'));
				notifyOk(_('Folder created'));
				self.loadPane(id, true);
			});
		});
	},

	renameEntry: function (id, entry) {
		var self = this;
		this.promptName(_('Rename'), entry.name, _('Rename')).then(function (name) {
			if (!name || name === entry.name) return;
			callRename(entry.path, name).then(function (r) {
				if (!r || r.ok === false) return notifyError(r, _('Cannot rename'));
				notifyOk(_('Renamed'));
				self.loadPane(id, true);
			});
		});
	},

	/* ------------------------------------------------------- delete */

	deleteEntries: function (id, entries) {
		var self = this;
		if (!entries.length) return;

		var SYSTEM = ['/etc', '/overlay', '/rom', '/usr', '/lib', '/bin', '/sbin', '/boot', '/www'];
		var systemish = entries.some(function (e) { return SYSTEM.indexOf(e.path) >= 0; });

		var msg;
		if (entries.length === 1)
			msg = (entries[0].type === 'directory')
				? _('Delete folder "%s" and all of its contents?').format(entries[0].name)
				: _('Delete "%s"?').format(entries[0].name);
		else
			msg = N_(entries.length, 'Delete %d selected item?', 'Delete %d selected items?').format(entries.length);

		var body = [
			E('p', {}, msg),
			E('div', { class: 'fx-del-list' }, entries.slice(0, 12).map(function (e) {
				return E('div', {}, e.path);
			}).concat(entries.length > 12
				? [E('div', {}, _('…and %d more').format(entries.length - 12))] : [])),
			E('p', { class: 'fx-warn' }, _('This action cannot be undone.'))
		];
		if (systemish)
			body.push(E('p', { class: 'fx-warn fx-warn-strong' },
				_('WARNING: this includes a core system path. Deleting it can break the router.')));

		ui.showModal(_('Confirm delete'), body.concat([
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					class: 'btn cbi-button-remove',
					click: function () {
						ui.hideModal();
						callRemove(entries.map(function (e) { return e.path; })).then(function (r) {
							if (!r || r.ok === false) return notifyError(r, _('Delete failed'));
							self.reportBulk(r, _('Deleted'));
							self.refreshAll();
						});
					}
				}, _('Delete'))
			])
		]));
	},

	/* --------------------------------------------------- copy / move */

	copyOrMove: function (mode, id, entries) {
		var self = this;
		if (!entries.length) return;

		var destPane = this.panes[this.other(id)];
		var destInput = E('input', { type: 'text', class: 'cbi-input-text fx-full', value: destPane.path });
		destInput.addEventListener('keydown', function (ev) { ev.stopPropagation(); });

		var title = (mode === 'copy') ? _('Copy') : _('Move');
		var heading = (entries.length === 1)
			? ((mode === 'copy')
				? _('Copy "%s" to:').format(entries[0].name)
				: _('Move "%s" to:').format(entries[0].name))
			: ((mode === 'copy')
				? N_(entries.length, 'Copy %d item to:', 'Copy %d items to:').format(entries.length)
				: N_(entries.length, 'Move %d item to:', 'Move %d items to:').format(entries.length));

		function run(destination, overwrite) {
			var items = entries.map(function (e) { return e.path; });
			var call = (mode === 'copy') ? callCopy : callMove;
			return call(items, destination, !!overwrite).then(function (r) {
				if (!r || r.ok === false) {
					notifyError(r, _('Operation failed'));
					return;
				}
				var conflicts = (r.results || []).filter(function (x) {
					return !x.ok && x.error && x.error.code === 'EEXIST';
				});
				if (conflicts.length && !overwrite) {
					self.confirmOverwrite(conflicts.length, function () {
						run(destination, true).then(function () { self.refreshAll(); });
					});
					self.refreshAll();
					return;
				}
				self.reportBulk(r, (mode === 'copy') ? _('Copied') : _('Moved'));
				self.refreshAll();
			});
		}

		ui.showModal(title, [
			E('p', {}, heading),
			E('div', { class: 'fx-del-list' }, entries.slice(0, 12).map(function (e) {
				return E('div', {}, e.path);
			}).concat(entries.length > 12
				? [E('div', {}, _('…and %d more').format(entries.length - 12))] : [])),
			E('div', { class: 'fx-dest-row' }, [
				destInput,
				E('button', {
					class: 'btn', click: function () {
						pickDirectory(destInput.value).then(function (d) { if (d) destInput.value = d; });
					}
				}, _('Browse…'))
			]),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					class: 'btn cbi-button-action',
					click: function () {
						var d = destInput.value;
						ui.hideModal();
						run(d, false);
					}
				}, title)
			])
		]);
	},

	confirmOverwrite: function (n, onYes) {
		ui.showModal(_('Items already exist'), [
			E('p', {}, N_(n, '%d item already exists at the destination. Overwrite it?',
				'%d items already exist at the destination. Overwrite them?').format(n)),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					class: 'btn cbi-button-negative',
					click: function () { ui.hideModal(); onYes(); }
				}, _('Overwrite'))
			])
		]);
	},

	reportBulk: function (reply, okMsg) {
		var failed = (reply.results || []).filter(function (r) { return !r.ok; });
		if (!failed.length) { notifyOk(okMsg); return; }
		ui.addNotification(null, E('div', {}, failed.map(function (f) {
			return E('p', {}, (f.path || '') + ': ' + errorMessage(f, _('failed')));
		})), 'error');
	},

	/* ---------------------------------------------------- properties */

	propertiesEntry: function (entry) {
		callStat(entry.path).then(function (st) {
			if (!st || st.ok === false) return notifyError(st, _('Cannot read properties'));
			var rows = [
				[_('Name'), st.name],
				[_('Path'), st.path],
				[_('Type'), typeLabel(classify(st))],
				[_('Size'), st.type === 'directory' ? '—' : fmtSize(st.size)],
				[_('Owner'), st.owner + ' (' + st.uid + ')'],
				[_('Group'), st.group + ' (' + st.gid + ')'],
				[_('Permissions'), st.mode_string + ' (' + st.mode_octal + ')'],
				[_('Modified'), fmtTime(st.mtime)],
				[_('Accessed'), fmtTime(st.atime)],
				[_('Changed'), fmtTime(st.ctime)],
				[_('Filesystem'), st.fstype + ' · ' + st.mount]
			];
			if (st.is_symlink)
				rows.splice(3, 0, [_('Symlink target'),
					st.symlink_target + (st.broken ? ' (' + _('broken') + ')' : '')]);

			ui.showModal(_('Properties'), [
				E('table', { class: 'table fx-props' }, rows.map(function (r) {
					return E('tr', { class: 'tr' }, [
						E('td', { class: 'td fx-prop-k' }, r[0]),
						E('td', { class: 'td fx-prop-v' }, String(r[1]))
					]);
				})),
				E('div', { class: 'right fx-modal-actions' },
					E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
			]);
		});
	},

	/* --------------------------------------------------- permissions */

	permissionsEntry: function (id, entry) {
		var self = this;
		callStat(entry.path).then(function (st) {
			if (!st || st.ok === false) return notifyError(st, _('Cannot read permissions'));
			var octal = parseInt(st.mode_octal, 8);
			var checks = {};

			function bit(mask) { return (octal & mask) !== 0; }

			function row(label, keys, masks) {
				var cells = [E('td', { class: 'td' }, label)];
				keys.forEach(function (k, i) {
					checks[k] = E('input', { type: 'checkbox' });
					checks[k].checked = bit(masks[i]);
					checks[k].addEventListener('change', recompute);
					cells.push(E('td', { class: 'td' }, checks[k]));
				});
				return E('tr', { class: 'tr' }, cells);
			}

			var preview = E('div', { class: 'fx-mode-preview' });

			function recompute() {
				var m =
					(checks.ur.checked ? 0o400 : 0) | (checks.uw.checked ? 0o200 : 0) | (checks.ux.checked ? 0o100 : 0) |
					(checks.gr.checked ? 0o040 : 0) | (checks.gw.checked ? 0o020 : 0) | (checks.gx.checked ? 0o010 : 0) |
					(checks.or.checked ? 0o004 : 0) | (checks.ow.checked ? 0o002 : 0) | (checks.ox.checked ? 0o001 : 0);
				var s = '';
				s += checks.ur.checked ? 'r' : '-';
				s += checks.uw.checked ? 'w' : '-';
				s += checks.ux.checked ? 'x' : '-';
				s += checks.gr.checked ? 'r' : '-';
				s += checks.gw.checked ? 'w' : '-';
				s += checks.gx.checked ? 'x' : '-';
				s += checks.or.checked ? 'r' : '-';
				s += checks.ow.checked ? 'w' : '-';
				s += checks.ox.checked ? 'x' : '-';
				preview.textContent = s + '  ' + ('0000' + m.toString(8)).slice(-4);
				return m;
			}

			var table = E('table', { class: 'table' }, [
				E('tr', { class: 'tr table-titles' }, [
					E('th', { class: 'th' }, ''),
					E('th', { class: 'th' }, _('Read')),
					E('th', { class: 'th' }, _('Write')),
					E('th', { class: 'th' }, _('Execute'))
				]),
				row(_('Owner'), ['ur', 'uw', 'ux'], [0o400, 0o200, 0o100]),
				row(_('Group'), ['gr', 'gw', 'gx'], [0o040, 0o020, 0o010]),
				row(_('Others'), ['or', 'ow', 'ox'], [0o004, 0o002, 0o001])
			]);
			recompute();

			var uidInput = E('input', { type: 'text', class: 'cbi-input-text fx-num', value: st.uid });
			var gidInput = E('input', { type: 'text', class: 'cbi-input-text fx-num', value: st.gid });
			[uidInput, gidInput].forEach(function (i) {
				i.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
			});

			ui.showModal(_('Permissions') + ' — ' + entry.name, [
				table,
				preview,
				E('div', { class: 'fx-owner-row' }, [
					E('label', {}, _('User ID')), uidInput,
					E('label', {}, _('Group ID')), gidInput
				]),
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						class: 'btn cbi-button-action',
						click: function () {
							var mode = recompute();
							var ops = [callChmod(entry.path, mode)];
							var u = parseInt(uidInput.value, 10);
							var g = parseInt(gidInput.value, 10);
							if (u !== st.uid || g !== st.gid)
								ops.push(callChown(entry.path, isNaN(u) ? -1 : u, isNaN(g) ? -1 : g));
							ui.hideModal();
							Promise.all(ops).then(function (rs) {
								var bad = rs.filter(function (r) { return !r || r.ok === false; });
								if (bad.length) notifyError(bad[0], _('Cannot change permissions'));
								else notifyOk(_('Permissions updated'));
								self.loadPane(id, true);
							});
						}
					}, _('Apply'))
				])
			]);
		});
	},

	/* ------------------------------------------------------- preview */

	previewEntry: function (entry) {
		var self = this;
		callRead(entry.path, 'preview').then(function (r) {
			if (!r || r.ok === false) {
				if (r && r.error && r.error.code === 'EFBIG')
					return self.previewTooLarge(entry);
				return notifyError(r, _('Cannot open file'));
			}
			if (r.is_binary) {
				if (classify(entry) === 'image') return self.previewImage(entry);
				return self.previewBinary(entry);
			}
			ui.showModal(entry.path, [
				E('pre', { class: 'fx-pre' }, b64DecodeUtf8(r.data)),
				r.truncated ? E('p', { class: 'fx-warn' },
					_('Preview truncated, the file is %s.').format(fmtSize(r.size))) : '',
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: function () { self.downloadEntry(entry); } }, _('Download')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: function () { ui.hideModal(); self.editEntry(entry); } }, _('Edit', 'filexplorer')),
					' ',
					E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
				])
			], 'fx-modal-wide');
		});
	},

	previewImage: function (entry) {
		var self = this;
		ui.showModal(entry.path, [
			E('div', { class: 'fx-img-wrap' }, E('img', { src: this.downloadUrl(entry.path) })),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: function () { self.downloadEntry(entry); } }, _('Download')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
			])
		], 'fx-modal-wide');
	},

	previewBinary: function (entry) {
		var self = this;
		ui.showModal(entry.path, [
			E('p', {}, _('This is a binary file and cannot be shown as text.')),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn cbi-button-action', click: function () { self.downloadEntry(entry); } }, _('Download')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
			])
		]);
	},

	previewTooLarge: function (entry) {
		var self = this;
		function part(mode, label) {
			return E('button', {
				class: 'btn', click: function () {
					callRead(entry.path, mode).then(function (r) {
						if (!r || r.ok === false) return notifyError(r, _('Cannot open file'));
						ui.showModal(entry.path + ' — ' + label, [
							E('pre', { class: 'fx-pre' }, b64DecodeUtf8(r.data)),
							E('div', { class: 'right fx-modal-actions' },
								E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
						], 'fx-modal-wide');
					});
				}
			}, label);
		}
		ui.showModal(entry.path, [
			E('p', {}, _('The file is too large to show in full.')),
			E('div', { class: 'right fx-modal-actions' }, [
				part('head', _('First part')), ' ',
				part('tail', _('Last part')), ' ',
				E('button', { class: 'btn cbi-button-action', click: function () { self.downloadEntry(entry); } }, _('Download')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
			])
		]);
	},

	/* -------------------------------------------------------- editor */

	editEntry: function (entry) {
		var self = this;
		callRead(entry.path, 'edit').then(function (r) {
			if (!r || r.ok === false) {
				if (r && r.error && r.error.code === 'EFBIG')
					return ui.addNotification(null, E('p', {}, _('The file is too large to edit. Download it instead.')), 'warning');
				if (r && r.error && r.error.code === 'EINVAL')
					return ui.addNotification(null, E('p', {}, _('This does not look like a text file.')), 'warning');
				return notifyError(r, _('Cannot open file'));
			}

			var textarea = E('textarea', {
				class: 'fx-editor' + (self.wrapEditor ? '' : ' fx-editor-nowrap'),
				spellcheck: 'false',
				/* the attribute is what actually stops the browser from
				   wrapping; the class only styles the overflow */
				wrap: self.wrapEditor ? 'soft' : 'off'
			}, b64DecodeUtf8(r.data));
			var dirty = false;
			var mtime = r.mtime, size = r.size;

			textarea.addEventListener('input', function () { dirty = true; });
			textarea.addEventListener('keydown', function (ev) {
				ev.stopPropagation();
				if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
					ev.preventDefault();
					save(false);
				}
			});

			function save(force) {
				var content = textarea.value;
				callWrite(entry.path, b64EncodeUtf8(content), 'base64', mtime, size, !!force).then(function (w) {
					if (!w || w.ok === false) {
						if (w && w.error && w.error.code === 'ECONFLICT') {
							ui.showModal(_('File changed on disk'), [
								E('p', {}, _('This file was modified by something else after you opened it. Overwrite those changes?')),
								E('div', { class: 'right fx-modal-actions' }, [
									E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
									' ',
									E('button', {
										class: 'btn cbi-button-negative',
										click: function () { ui.hideModal(); save(true); }
									}, _('Overwrite'))
								])
							]);
							return;
						}
						return notifyError(w, _('Cannot save file'));
					}
					dirty = false;
					mtime = w.mtime;
					size = w.size;
					notifyOk(_('Saved'));
				});
			}

			function close() {
				if (!dirty) { ui.hideModal(); return; }
				ui.showModal(_('Unsaved changes'), [
					E('p', {}, _('You have unsaved changes. Discard them?')),
					E('div', { class: 'right fx-modal-actions' }, [
						E('button', { class: 'btn', click: function () { ui.hideModal(); self.editEntry(entry); } }, _('Keep editing')),
						' ',
						E('button', { class: 'btn cbi-button-negative', click: ui.hideModal }, _('Discard'))
					])
				]);
			}

			ui.showModal(entry.path, [
				textarea,
				E('div', { class: 'fx-editor-hint' }, _('Press Ctrl+S to save.')),
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: close }, _('Cancel')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: function () { save(false); } }, _('Save'))
				])
			], 'fx-modal-wide');

			textarea.focus();
		});
	},

	/* ------------------------------------------------------ download */

	downloadUrl: function (path) {
		return L.url('admin', 'services', 'filexplorer', 'download') + '?path=' + encodeURIComponent(path);
	},

	downloadEntry: function (entry) {
		var a = E('a', { href: this.downloadUrl(entry.path), download: entry.name, style: 'display:none' });
		document.body.appendChild(a);
		a.click();
		window.setTimeout(function () { a.remove(); }, 1000);
	},

	/* -------------------------------------------------------- upload */

	actUpload: function () {
		var self = this;
		var id = this.active;
		var dest = this.panes[id].path;
		var input = E('input', { type: 'file', multiple: true, style: 'display:none' });
		document.body.appendChild(input);
		input.addEventListener('change', function () {
			var files = Array.prototype.slice.call(input.files || []);
			input.remove();
			if (files.length) self.uploadFiles(files, dest, id);
		});
		input.click();
	},

	uploadFiles: function (files, dest, paneId) {
		var self = this;
		var total = files.length;
		var idx = 0;
		var cancelled = false;
		var xhr = null;

		var overall = E('div', { class: 'fx-up-overall' });
		var fileLabel = E('div', { class: 'fx-up-name' });
		var fill = E('div', { class: 'fx-bar-fill' });
		var destLine = E('div', { class: 'fx-up-dest' }, _('Destination: %s').format(dest));

		ui.showModal(_('Uploading'), [
			destLine, overall, fileLabel,
			E('div', { class: 'fx-bar' }, fill),
			E('div', { class: 'right fx-modal-actions' },
				E('button', {
					class: 'btn',
					click: function () { cancelled = true; if (xhr) xhr.abort(); ui.hideModal(); }
				}, _('Cancel')))
		]);

		function post(file, overwrite, onDone) {
			var fd = new FormData();
			fd.append('file', file, file.name);
			xhr = new XMLHttpRequest();
			xhr.open('POST', L.url('admin', 'services', 'filexplorer', 'upload') +
				'?dest=' + encodeURIComponent(dest) + '&overwrite=' + (overwrite ? '1' : '0'));
			xhr.upload.addEventListener('progress', function (ev) {
				if (ev.lengthComputable)
					fill.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
			});
			xhr.onload = function () {
				var resp = null;
				try { resp = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
				onDone(xhr.status, resp);
			};
			xhr.onerror = function () { onDone(0, null); };
			xhr.send(fd);
		}

		function next() {
			if (cancelled) return;
			if (idx >= total) {
				ui.hideModal();
				notifyOk(N_(total, 'Uploaded %d file', 'Uploaded %d files').format(total));
				self.loadPane(paneId, true);
				return;
			}
			var file = files[idx];
			fileLabel.textContent = file.name;
			overall.textContent = _('File %d of %d').format(idx + 1, total);
			fill.style.width = '0%';

			post(file, false, function (status, resp) {
				if (cancelled) return;
				if (status === 200 && resp && resp.ok) { idx++; next(); return; }
				if (resp && resp.error && resp.error.code === 'EEXIST') {
					self.confirmOverwrite(1, function () {
						post(file, true, function () { idx++; next(); });
					});
					return;
				}
				ui.addNotification(null, E('p', {},
					file.name + ': ' + errorMessage(resp, _('Upload failed'))), 'error');
				idx++;
				next();
			});
		}

		next();
	},

	/* -------------------------------------------------------- search */

	actSearch: function () {
		var self = this;
		var id = this.active;
		var base = this.panes[id].path;

		var input = E('input', { type: 'text', class: 'cbi-input-text fx-full', placeholder: _('Part of a file name') });
		var recursive = E('input', { type: 'checkbox' });
		var results = E('div', { class: 'fx-search-results' });
		var timer = null;

		input.addEventListener('keydown', function (ev) {
			ev.stopPropagation();
			if (ev.key === 'Enter') { window.clearTimeout(timer); run(); }
		});
		input.addEventListener('input', function () {
			window.clearTimeout(timer);
			timer = window.setTimeout(run, 400);
		});
		recursive.addEventListener('change', run);

		function run() {
			var q = input.value;
			if (!q) { results.innerHTML = ''; return; }
			dom.content(results, E('div', { class: 'fx-loading' }, _('Searching…')));
			callSearch(base, q, recursive.checked, 500).then(function (r) {
				if (!r || r.ok === false) {
					dom.content(results, E('p', { class: 'alert-message warning' },
						errorMessage(r, _('Search failed'))));
					return;
				}
				if (!r.results.length) {
					dom.content(results, E('div', { class: 'fx-empty' }, _('Nothing found')));
					return;
				}
				var rows = r.results.map(function (entry) {
					return E('div', {
						class: 'fx-search-row',
						click: function () {
							ui.hideModal();
							var dir = (entry.type === 'directory') ? entry.path : dirName(entry.path);
							self.navigate(id, dir);
						}
					}, [
						E('span', { class: 'fx-ico' }, iconFor(entry, classify(entry))),
						E('span', { class: 'fx-search-name' }, entry.name),
						E('span', { class: 'fx-search-path' }, dirName(entry.path))
					]);
				});
				if (r.truncated)
					rows.push(E('div', { class: 'fx-warn' },
						_('Too many matches, only the first %d are shown.').format(r.results.length)));
				dom.content(results, rows);
			});
		}

		ui.showModal(_('Search'), [
			E('p', {}, _('Searching in: %s').format(base)),
			input,
			E('label', { class: 'fx-check-row' }, [recursive, ' ', _('Search inside subfolders')]),
			results,
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
		], 'fx-modal-wide');

		input.focus();
	},

	/* ------------------------------------------------------ settings */

	/* Deliberately short. A file manager's settings dialog is where
	   options accumulate; these are the ones that change how the list
	   itself reads or where the panels start, and each is a single
	   switch. Anything that belongs to one file (permissions, say) lives
	   on that file, not here. */
	actSettings: function () {
		var self = this;

		/* `redraw` is off for options that only take effect the next time
		   something is opened, so the dialog does not repaint the panels
		   for no reason. */
		function check(label, hint, prop, key, redraw) {
			var cb = E('input', { type: 'checkbox' });
			cb.checked = self[prop];
			cb.addEventListener('change', function () {
				self[prop] = cb.checked;
				lsSet(key, cb.checked);
				if (redraw) {
					self.renderBody('left');
					self.renderBody('right');
					self.renderFoot('left');
					self.renderFoot('right');
				}
			});
			return E('label', { class: 'fx-set-row' }, [
				cb,
				E('span', { class: 'fx-set-text' }, [
					E('span', { class: 'fx-set-label' }, label),
					hint ? E('span', { class: 'fx-set-hint' }, hint) : ''
				])
			]);
		}

		function group(title, kids) {
			return E('div', { class: 'fx-set-group' },
				[E('div', { class: 'fx-set-group-title' }, title)].concat(kids));
		}

		ui.showModal(_('Settings'), [
			E('div', { class: 'fx-settings' }, [
				group(_('Appearance'), [
					check(_('Show hidden files'),
						_('Files and folders whose name starts with a dot.'),
						'showHidden', 'showHidden', true),
					check(_('Folders first'),
						_('Sort folders above files, whatever the sort column.'),
						'dirsFirst', 'dirsFirst', true)
				]),
				group(_('Panels'), [
					check(_('Remember panel paths'),
						_('Open both panels where you left them last time.'),
						'rememberPaths', 'rememberPaths', false),
					E('div', { class: 'fx-set-row fx-set-row-action' }, [
						E('span', { class: 'fx-set-text' }, [
							E('span', { class: 'fx-set-label' }, _('Column widths')),
							E('span', { class: 'fx-set-hint' },
								_('Drag the edge of a column header to change it.'))
						]),
						E('button', {
							class: 'btn cbi-button',
							click: function () {
								for (var k in COLUMNS)
									self.resetColumnWidth(k);
							}
						}, _('Reset', 'filexplorer'))
					])
				]),
				group(_('Editor'), [
					check(_('Wrap long lines'),
						_('Applies the next time a file is opened for editing.'),
						'wrapEditor', 'wrapEditor', false)
				])
			]),
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Close')))
		]);
	},

	/* A two-column grid rather than a full-width table: the keys are
	   right-aligned against the middle gutter and the descriptions start
	   just after it, and the whole block is only as wide as its content
	   and centred in the dialog. The old table stretched to the full
	   modal width with a 40% key column, which left a stripe of empty
	   space between every key and the thing it does. */
	actShortcuts: function () {
		var rows = [];

		function group(title) {
			rows.push(E('div', { class: 'fx-keys-group' }, title));
		}

		function row(keys, what) {
			rows.push(E('div', { class: 'fx-keys-k' },
				keys.map(function (k) { return E('kbd', {}, k); })));
			rows.push(E('div', { class: 'fx-keys-v' }, what));
		}

		group(_('Navigation'));
		row(['Tab'], _('Switch panel'));
		row(['Enter'], _('Open'));
		row(['Backspace'], _('Go up one level'));
		row(['Ctrl', 'R'], _('Refresh the active panel'));

		group(_('Selection'));
		row(['Insert', 'Space'], _('Select or unselect'));
		row(['Ctrl', 'A'], _('Select all'));
		row(['Ctrl', 'Space'], _('Calculate folder size'));

		group(_('File actions'));
		row(['F2'], _('Rename'));
		row(['F3'], _('View'));
		row(['F4'], _('Edit', 'filexplorer'));
		row(['F5'], _('Copy'));
		row(['F6'], _('Move'));
		row(['F7'], _('New folder'));
		row(['F8', 'Delete'], _('Delete'));
		row(['Ctrl', 'S'], _('Save in the editor'));

		ui.showModal(_('Keyboard shortcuts'), [
			E('div', { class: 'fx-keys' }, rows),
			E('p', { class: 'fx-help fx-help-centred' },
				_('Shortcuts work while the file list has focus, not while typing in a field.')),
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Close')))
		]);
	}

});
