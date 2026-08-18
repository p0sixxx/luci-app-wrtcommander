'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

/* ==================================================================
 * FileXplorer - LuCI JS view
 *
 * Talks to the "luci.filexplorer" ubus object for every filesystem
 * operation (see /usr/share/rpcd/ucode/filexplorer.uc) and to two
 * plain HTTP endpoints on the Lua controller for streaming upload
 * and download (see /usr/lib/lua/luci/controller/filexplorer.lua).
 *
 * The backend is the sole security boundary: every call below is a
 * convenience for the user, never the reason an operation is allowed.
 * Hiding a button here is UX, not access control.
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

var LS_PREFIX = 'filexplorer.';

/* ------------------------------------------------------------------
 * small utilities
 * ------------------------------------------------------------------ */

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
		return n + ' B';
	var units = ['KiB', 'MiB', 'GiB', 'TiB'];
	var v = n;
	for (var i = 0; i < units.length; i++) {
		v = v / 1024;
		if (v < 1024 || i === units.length - 1)
			return v.toFixed(v < 10 ? 2 : (v < 100 ? 1 : 0)) + ' ' + units[i];
	}
}

function fmtTime(sec) {
	if (!sec)
		return '—';
	var d = new Date(sec * 1000);
	return d.toLocaleString();
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

function baseName(p) {
	var idx = p.lastIndexOf('/');
	return idx < 0 ? p : p.substring(idx + 1);
}

var TEXT_EXT = ['txt', 'conf', 'cfg', 'ini', 'json', 'xml', 'html', 'htm', 'css', 'js', 'lua', 'uc', 'sh', 'log', 'uci', 'md', 'yml', 'yaml', 'csv', 'crontab', 'hosts'];
var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
var ARCHIVE_EXT = ['tar', 'gz', 'tgz', 'bz2', 'xz', 'zip', 'ipk', 'apk', '7z', 'rar'];

function extOf(name) {
	var idx = name.lastIndexOf('.');
	return (idx <= 0) ? '' : name.substring(idx + 1).toLowerCase();
}

function classify(entry) {
	if (entry.type === 'directory') return 'Directory';
	if (entry.type === 'link') return 'Symlink';
	if (entry.type === 'char' || entry.type === 'block') return 'Device';
	if (entry.type === 'fifo') return 'FIFO';
	if (entry.type === 'socket') return 'Socket';
	var ext = extOf(entry.name);
	if (IMAGE_EXT.indexOf(ext) >= 0) return 'Image';
	if (ARCHIVE_EXT.indexOf(ext) >= 0) return 'Archive';
	if (TEXT_EXT.indexOf(ext) >= 0) return 'Text';
	if (entry.size === 0) return 'Text';
	return 'Binary';
}

function iconFor(entry, cls) {
	if (entry.type === 'directory') return '📁';
	if (entry.type === 'link') return entry.broken ? '⚠️' : '🔗';
	if (entry.type === 'char' || entry.type === 'block') return '🔌';
	if (entry.type === 'fifo' || entry.type === 'socket') return '🕳️';
	switch (cls) {
		case 'Image': return '🖼️';
		case 'Archive': return '📦';
		case 'Text': return '📄';
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
 * directory picker (used by Copy / Move / Upload destination)
 * ------------------------------------------------------------------ */

function pickDirectory(initialPath) {
	return new Promise(function (resolve) {
		var current = initialPath || '/';
		var listNode = E('div', { class: 'fx-picker-list' });
		var pathInput = E('input', {
			type: 'text', value: current, class: 'cbi-input-text',
			style: 'width:100%;box-sizing:border-box;margin-bottom:.5em'
		});

		function renderList(path) {
			listNode.innerHTML = '';
			listNode.appendChild(E('div', { class: 'spinning' }, _('Loading…')));
			callList(path, true).then(function (reply) {
				listNode.innerHTML = '';
				if (!reply || reply.ok === false) {
					listNode.appendChild(E('p', { class: 'alert-message warning' }, errorMessage(reply, _('Cannot open directory'))));
					return;
				}
				current = reply.path;
				pathInput.value = current;
				var dirs = reply.entries.filter(function (e) { return e.type === 'directory' || (e.type === 'link' && e.target_type === 'directory'); });
				dirs.sort(function (a, b) { return a.name.localeCompare(b.name); });
				if (reply.parent !== null) {
					listNode.appendChild(E('div', { class: 'fx-picker-item', click: function () { renderList(reply.parent); } }, '⬆️ ..'));
				}
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
			if (ev.key === 'Enter')
				renderList(pathInput.value);
		});

		var modal = ui.showModal(_('Select destination'), [
			pathInput,
			listNode,
			E('div', { class: 'right', style: 'margin-top:1em' }, [
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
		this.injectCss();

		this.path = lsGet('lastPath', '/');
		this.sortKey = lsGet('sortKey', 'name');
		this.sortDir = lsGet('sortDir', 'asc');
		this.dirsFirst = lsGet('dirsFirst', true);
		this.showHidden = lsGet('showHidden', true);
		this.selected = {};
		this.entries = [];
		this.parent = null;
		this.allowedRoot = '/';

		this.root = E('div', { class: 'fx-fm' }, [
			this.breadcrumbNode = E('div', { class: 'fx-breadcrumb' }),
			this.toolbarNode = E('div', { class: 'fx-toolbar' }),
			this.diskInfoNode = E('div', { class: 'fx-diskinfo' }),
			this.tableWrap = E('div', { class: 'fx-table-wrap' },
				this.tableNode = E('table', { class: 'table fx-table' })),
			this.statusNode = E('div', { class: 'fx-status' })
		]);

		this.loadDir(this.path);

		return this.root;
	},

	injectCss: function () {
		if (document.getElementById('filexplorer-css'))
			return;
		var link = E('link', {
			id: 'filexplorer-css',
			rel: 'stylesheet',
			href: L.resource('filexplorer/filexplorer.css')
		});
		document.head.appendChild(link);
	},

	/* ---------------------------------------------------------- data */

	loadDir: function (path) {
		var self = this;
		dom.content(self.tableNode, E('tr', {}, E('td', { style: 'padding:1em' }, _('Loading…'))));
		return callList(path, true).then(function (reply) {
			if (!reply || reply.ok === false) {
				notifyError(reply, _('Cannot open directory'));
				if (path !== '/')
					return self.loadDir('/');
				return;
			}
			self.path = reply.path;
			self.parent = reply.parent;
			self.allowedRoot = reply.allowed_root || '/';
			self.entries = reply.entries;
			self.selected = {};
			lsSet('lastPath', self.path);
			self.renderBreadcrumb();
			self.renderToolbar();
			self.renderTable();
			self.loadDiskInfo();
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, _('Request failed: %s').format(err.message || err)), 'error');
		});
	},

	loadDiskInfo: function () {
		var self = this;
		callDiskInfo(self.path).then(function (reply) {
			self.diskInfoNode.innerHTML = '';
			if (!reply || reply.ok === false)
				return;
			self.diskInfoNode.appendChild(E('span', {}, [
				E('strong', {}, reply.mountpoint + ' '),
				'(' + reply.fstype + ') ',
				_('Total'), ': ', fmtSize(reply.total), ' ',
				_('Used'), ': ', fmtSize(reply.used), ' ',
				_('Free'), ': ', fmtSize(reply.free)
			]));
		}).catch(function () { /* non-critical */ });
	},

	refresh: function () {
		return this.loadDir(this.path);
	},

	/* ------------------------------------------------------ breadcrumb */

	renderBreadcrumb: function () {
		var self = this;
		var parts = self.path === '/' ? [] : self.path.split('/').filter(Boolean);
		var node = E('div', { class: 'fx-breadcrumb-inner' });

		node.appendChild(E('span', {
			class: 'fx-crumb', click: function () { self.loadDir('/'); }
		}, '🏠'));

		var acc = '';
		var crumbs = parts.map(function (p, i) {
			acc = joinPath(acc || '/', p);
			return { name: p, path: acc };
		});

		var visible = crumbs;
		var hidden = [];
		if (crumbs.length > 5) {
			hidden = crumbs.slice(1, crumbs.length - 2);
			visible = [crumbs[0]].concat(crumbs.slice(crumbs.length - 2));
		}

		function addCrumb(c) {
			node.appendChild(E('span', {}, ' / '));
			node.appendChild(E('span', {
				class: 'fx-crumb', click: function () { self.loadDir(c.path); }
			}, c.name));
		}

		if (hidden.length) {
			addCrumb(visible[0]);
			node.appendChild(E('span', {}, ' / '));
			node.appendChild(E('span', {
				class: 'fx-crumb fx-crumb-ellipsis',
				click: function () {
					ui.showModal(_('Path'), [
						E('ul', { class: 'fx-crumb-hidden-list' }, hidden.map(function (c) {
							return E('li', { click: function () { ui.hideModal(); self.loadDir(c.path); } }, c.name);
						})),
						E('div', { class: 'right' }, E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
					]);
				}
			}, '…'));
			visible.slice(1).forEach(addCrumb);
		} else {
			visible.forEach(addCrumb);
		}

		dom.content(self.breadcrumbNode, node);
	},

	/* --------------------------------------------------------- toolbar */

	renderToolbar: function () {
		var self = this;
		var nSel = Object.keys(self.selected).length;
		var node = E('div', { class: 'fx-toolbar-inner' });

		if (nSel > 0) {
			node.appendChild(E('span', { class: 'fx-sel-count' }, _('%d selected').format(nSel)));
			node.appendChild(this.btn(_('Copy'), function () { self.actionCopySelected(); }));
			node.appendChild(this.btn(_('Move'), function () { self.actionMoveSelected(); }));
			if (nSel === 1) {
				var only = self.selectedEntries()[0];
				if (only.type !== 'directory')
					node.appendChild(this.btn(_('Download'), function () { self.actionDownload(only); }));
			}
			node.appendChild(this.btn(_('Delete'), function () { self.actionDeleteSelected(); }, 'cbi-button-remove'));
			node.appendChild(this.btn(_('Clear selection'), function () { self.selected = {}; self.renderToolbar(); self.renderTable(); }));
		} else {
			node.appendChild(this.btn('⬆️ ' + _('Up'), function () { if (self.parent) self.loadDir(self.parent); }, null, !self.parent));
			node.appendChild(this.btn('↻ ' + _('Refresh'), function () { self.refresh(); }));
			node.appendChild(this.newMenuButton());
			node.appendChild(this.btn('⬆️ ' + _('Upload'), function () { self.actionUpload(); }));

			var search = E('input', { type: 'text', class: 'cbi-input-text fx-search', placeholder: _('Search…') });
			var searchTimer = null;
			search.addEventListener('input', function () {
				window.clearTimeout(searchTimer);
				searchTimer = window.setTimeout(function () { self.actionSearch(search.value); }, 400);
			});
			search.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter') { window.clearTimeout(searchTimer); self.actionSearch(search.value, true); }
			});
			node.appendChild(search);

			node.appendChild(this.settingsButton());
		}

		dom.content(self.toolbarNode, node);
	},

	btn: function (label, fn, cls, disabled) {
		return E('button', {
			class: 'btn' + (cls ? ' ' + cls : ''),
			disabled: disabled ? true : null,
			click: ui.createHandlerFn(this, function (ev) { fn(); })
		}, label);
	},

	newMenuButton: function () {
		var self = this;
		var wrap = E('span', { class: 'fx-dropdown-wrap' });
		var btn = this.btn(_('New') + ' ▾', function () {
			menu.classList.toggle('open');
		});
		var menu = E('div', { class: 'fx-dropdown-menu' }, [
			E('div', { class: 'fx-dropdown-item', click: function () { menu.classList.remove('open'); self.actionNewFile(); } }, _('New File')),
			E('div', { class: 'fx-dropdown-item', click: function () { menu.classList.remove('open'); self.actionNewDir(); } }, _('New Directory'))
		]);
		wrap.appendChild(btn);
		wrap.appendChild(menu);
		return wrap;
	},

	settingsButton: function () {
		var self = this;
		var wrap = E('span', { class: 'fx-dropdown-wrap fx-settings' });
		var btn = this.btn('⚙️', function () { menu.classList.toggle('open'); });
		function mkCheck(label, key, prop) {
			var cb = E('input', { type: 'checkbox' });
			cb.checked = self[prop];
			cb.addEventListener('change', function () {
				self[prop] = cb.checked;
				lsSet(key, cb.checked);
				self.renderTable();
			});
			return E('label', { class: 'fx-dropdown-item' }, [cb, ' ' + label]);
		}
		var menu = E('div', { class: 'fx-dropdown-menu' }, [
			mkCheck(_('Show hidden files'), 'showHidden', 'showHidden'),
			mkCheck(_('Directories first'), 'dirsFirst', 'dirsFirst')
		]);
		wrap.appendChild(btn);
		wrap.appendChild(menu);
		return wrap;
	},

	/* ----------------------------------------------------------- table */

	sortedEntries: function () {
		var self = this;
		var list = self.entries.filter(function (e) { return self.showHidden || !e.hidden; });
		var key = self.sortKey, dir = self.sortDir === 'asc' ? 1 : -1;
		list.sort(function (a, b) {
			if (self.dirsFirst) {
				var ad = a.type === 'directory', bd = b.type === 'directory';
				if (ad !== bd) return ad ? -1 : 1;
			}
			var av = a[key], bv = b[key];
			if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
			if (av < bv) return -1 * dir;
			if (av > bv) return 1 * dir;
			return 0;
		});
		return list;
	},

	selectedEntries: function () {
		var self = this;
		return self.entries.filter(function (e) { return self.selected[e.path]; });
	},

	renderTable: function () {
		var self = this;
		var list = self.sortedEntries();

		function sortHeader(label, key) {
			var arrow = (self.sortKey === key) ? (self.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
			return E('th', {
				class: 'fx-sortable',
				click: function () {
					if (self.sortKey === key) self.sortDir = (self.sortDir === 'asc') ? 'desc' : 'asc';
					else { self.sortKey = key; self.sortDir = 'asc'; }
					lsSet('sortKey', self.sortKey);
					lsSet('sortDir', self.sortDir);
					self.renderTable();
				}
			}, label + arrow);
		}

		var allChecked = list.length > 0 && list.every(function (e) { return self.selected[e.path]; });
		var selectAll = E('input', { type: 'checkbox' });
		selectAll.checked = allChecked;
		selectAll.addEventListener('change', function () {
			if (selectAll.checked) list.forEach(function (e) { self.selected[e.path] = true; });
			else self.selected = {};
			self.renderToolbar();
			self.renderTable();
		});

		var thead = E('tr', { class: 'tr table-titles' }, [
			E('th', { class: 'th fx-col-check' }, selectAll),
			sortHeader(_('Name'), 'name'),
			E('th', { class: 'th fx-col-type' }, _('Type')),
			sortHeader(_('Size'), 'size'),
			sortHeader(_('Modified'), 'mtime'),
			E('th', { class: 'th fx-col-perm' }, _('Permissions')),
			E('th', { class: 'th fx-col-actions' }, '')
		]);

		var rows = [thead];

		if (!list.length) {
			rows.push(E('tr', { class: 'tr' }, E('td', { class: 'td', colspan: 7, style: 'padding:1.5em;text-align:center;opacity:.7' }, _('This directory is empty'))));
		}

		list.forEach(function (entry) {
			rows.push(self.renderRow(entry));
		});

		dom.content(self.tableNode, rows);
	},

	renderRow: function (entry) {
		var self = this;
		var cls = classify(entry);
		var icon = iconFor(entry, cls);
		var cb = E('input', { type: 'checkbox' });
		cb.checked = !!self.selected[entry.path];
		cb.addEventListener('change', function () {
			if (cb.checked) self.selected[entry.path] = true;
			else delete self.selected[entry.path];
			self.renderToolbar();
		});

		var nameLabel = entry.name + (entry.is_symlink ? (' → ' + (entry.symlink_target || '?')) : '');

		var nameCell = E('td', { class: 'td fx-col-name' }, E('span', {
			class: 'fx-name-link',
			click: function () { self.openEntry(entry); }
		}, [icon + ' ', nameLabel]));

		var row = E('tr', {
			class: 'tr' + (entry.hidden ? ' fx-hidden-row' : ''),
			contextmenu: function (ev) { ev.preventDefault(); self.showContextMenu(ev, entry); }
		}, [
			E('td', { class: 'td fx-col-check' }, cb),
			nameCell,
			E('td', { class: 'td fx-col-type' }, cls),
			E('td', { class: 'td fx-col-size' }, entry.type === 'directory' ? '—' : fmtSize(entry.size)),
			E('td', { class: 'td fx-col-mtime' }, fmtTime(entry.mtime)),
			E('td', { class: 'td fx-col-perm' }, entry.mode_string + ' ' + entry.owner + ':' + entry.group),
			E('td', { class: 'td fx-col-actions' }, E('button', {
				class: 'btn fx-more-btn',
				click: function (ev) { self.showContextMenu(ev, entry); }
			}, '⋮'))
		]);

		return row;
	},

	openEntry: function (entry) {
		if (entry.type === 'directory' || (entry.type === 'link' && entry.target_type === 'directory')) {
			this.loadDir(entry.path);
			return;
		}
		if (entry.type === 'link' && entry.broken) {
			notifyOk(_('Broken symlink → %s').format(entry.symlink_target));
			return;
		}
		this.actionPreview(entry);
	},

	/* ------------------------------------------------------- context menu */

	showContextMenu: function (ev, entry) {
		ev.preventDefault();
		ev.stopPropagation();
		var self = this;
		this.closeContextMenu();

		var items = [];
		var isDir = entry.type === 'directory';
		var isLink = entry.type === 'link';

		items.push([_('Open'), function () { self.openEntry(entry); }]);
		if (!isDir) {
			items.push([_('Preview'), function () { self.actionPreview(entry); }]);
			items.push([_('Edit'), function () { self.actionEdit(entry); }]);
			items.push([_('Download'), function () { self.actionDownload(entry); }]);
		}
		items.push([_('Copy'), function () { self.selected = {}; self.selected[entry.path] = true; self.actionCopySelected(); }]);
		items.push([_('Move'), function () { self.selected = {}; self.selected[entry.path] = true; self.actionMoveSelected(); }]);
		items.push([_('Rename'), function () { self.actionRename(entry); }]);
		items.push([_('Delete'), function () { self.selected = {}; self.selected[entry.path] = true; self.actionDeleteSelected(); }]);
		if (!isLink) {
			items.push([_('Permissions'), function () { self.actionPermissions(entry); }]);
		}
		items.push([_('Properties'), function () { self.actionProperties(entry); }]);

		var menu = E('div', { class: 'fx-ctx-menu' }, items.map(function (it) {
			return E('div', {
				class: 'fx-ctx-item',
				click: function () { self.closeContextMenu(); it[1](); }
			}, it[0]);
		}));

		var x = ev.clientX, y = ev.clientY;
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';
		document.body.appendChild(menu);

		var vw = window.innerWidth, vh = window.innerHeight;
		var rect = menu.getBoundingClientRect();
		if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 8) + 'px';
		if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 8) + 'px';

		this._ctxMenu = menu;
		this._ctxCloser = function (e) {
			if (!menu.contains(e.target)) self.closeContextMenu();
		};
		window.setTimeout(function () {
			document.addEventListener('click', self._ctxCloser);
			document.addEventListener('contextmenu', self._ctxCloser);
		}, 0);
	},

	closeContextMenu: function () {
		if (this._ctxMenu) {
			this._ctxMenu.remove();
			this._ctxMenu = null;
		}
		if (this._ctxCloser) {
			document.removeEventListener('click', this._ctxCloser);
			document.removeEventListener('contextmenu', this._ctxCloser);
			this._ctxCloser = null;
		}
	},

	/* -------------------------------------------------------- create/rename */

	validateName: function (name) {
		if (!name || !name.length) return _('Name cannot be empty');
		if (name === '.' || name === '..') return _('Invalid name');
		if (name.indexOf('/') >= 0) return _('Name cannot contain "/"');
		if (name.length > 255) return _('Name is too long');
		return null;
	},

	promptName: function (title, initial) {
		var self = this;
		return new Promise(function (resolve) {
			var input = E('input', { type: 'text', class: 'cbi-input-text', style: 'width:100%;box-sizing:border-box', value: initial || '' });
			var err = E('div', { class: 'fx-form-error' });
			function submit() {
				var v = input.value;
				var e = self.validateName(v);
				if (e) { err.textContent = e; return; }
				ui.hideModal();
				resolve(v);
			}
			input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });
			ui.showModal(title, [
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, _('Name') + ':'),
					input
				]),
				err,
				E('div', { class: 'right', style: 'margin-top:1em' }, [
					E('button', { class: 'btn', click: function () { ui.hideModal(); resolve(null); } }, _('Cancel')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: submit }, _('Create'))
				])
			]);
			input.focus();
		});
	},

	actionNewFile: function () {
		var self = this;
		this.promptName(_('New File')).then(function (name) {
			if (!name) return;
			callCreate(joinPath(self.path, name)).then(function (reply) {
				if (!reply || reply.ok === false) return notifyError(reply, _('Cannot create file'));
				notifyOk(_('File created'));
				self.refresh();
			});
		});
	},

	actionNewDir: function () {
		var self = this;
		this.promptName(_('New Directory')).then(function (name) {
			if (!name) return;
			callMkdir(joinPath(self.path, name)).then(function (reply) {
				if (!reply || reply.ok === false) return notifyError(reply, _('Cannot create directory'));
				notifyOk(_('Directory created'));
				self.refresh();
			});
		});
	},

	actionRename: function (entry) {
		var self = this;
		this.promptName(_('Rename "%s"').format(entry.name), entry.name).then(function (name) {
			if (!name || name === entry.name) return;
			callRename(entry.path, name).then(function (reply) {
				if (!reply || reply.ok === false) return notifyError(reply, _('Cannot rename'));
				notifyOk(_('Renamed'));
				self.refresh();
			});
		});
	},

	/* ---------------------------------------------------------------- delete */

	actionDeleteSelected: function () {
		var self = this;
		var entries = self.selectedEntries();
		if (!entries.length) return;

		var hasDir = entries.some(function (e) { return e.type === 'directory'; });
		var systemish = entries.some(function (e) {
			return ['/etc', '/overlay', '/rom', '/usr', '/lib', '/bin', '/sbin', '/boot'].indexOf(e.path) >= 0;
		});

		var msg = (entries.length === 1)
			? (entries[0].type === 'directory'
				? _('Delete directory "%s" and its contents?').format(entries[0].name)
				: _('Delete "%s"?').format(entries[0].name))
			: _('Delete %d selected items?').format(entries.length);

		var body = [E('p', {}, msg), E('p', { class: 'fx-warn' }, _('This action cannot be undone.'))];
		if (systemish)
			body.push(E('p', { class: 'fx-warn fx-warn-strong' }, _('WARNING: this includes a core system path. Deleting it can break the router.')));

		ui.showModal(_('Confirm delete'), body.concat([
			E('div', { class: 'right', style: 'margin-top:1em' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					class: 'btn cbi-button-remove',
					click: function () {
						ui.hideModal();
						callRemove(entries.map(function (e) { return e.path; })).then(function (reply) {
							if (!reply || reply.ok === false) return notifyError(reply, _('Delete failed'));
							var failed = reply.results.filter(function (r) { return !r.ok; });
							if (failed.length) {
								ui.addNotification(null, E('div', {}, failed.map(function (f) {
									return E('p', {}, (f.path || '') + ': ' + errorMessage(f, _('failed')));
								})), 'error');
							} else {
								notifyOk(_('Deleted'));
							}
							self.refresh();
						});
					}
				}, _('Delete'))
			])
		]));
	},

	/* ------------------------------------------------------------ copy/move */

	actionCopySelected: function () {
		this.copyOrMove('copy');
	},
	actionMoveSelected: function () {
		this.copyOrMove('move');
	},

	copyOrMove: function (mode) {
		var self = this;
		var entries = self.selectedEntries();
		if (!entries.length) return;
		pickDirectory(self.path).then(function (dest) {
			if (!dest) return;
			var items = entries.map(function (e) { return e.path; });
			var call = (mode === 'copy') ? callCopy : callMove;
			call(items, dest, false).then(function (reply) {
				if (!reply || reply.ok === false) return notifyError(reply, _('Operation failed'));
				var failed = reply.results.filter(function (r) { return !r.ok; });
				var conflicts = failed.filter(function (r) { return r.error && r.error.code === 'EEXIST'; });
				if (conflicts.length) {
					self.confirmOverwrite(conflicts.length, function () {
						call(items, dest, true).then(function (r2) {
							self.reportBulkResult(r2, mode);
							self.refresh();
						});
					});
				} else {
					self.reportBulkResult(reply, mode);
				}
				self.refresh();
			});
		});
	},

	confirmOverwrite: function (n, onYes) {
		ui.showModal(_('Items already exist'), [
			E('p', {}, _('%d item(s) already exist at the destination. Overwrite them?').format(n)),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
				' ',
				E('button', { class: 'btn cbi-button-action', click: function () { ui.hideModal(); onYes(); } }, _('Overwrite'))
			])
		]);
	},

	reportBulkResult: function (reply, mode) {
		if (!reply || !reply.results) return;
		var failed = reply.results.filter(function (r) { return !r.ok; });
		if (!failed.length) {
			notifyOk(mode === 'copy' ? _('Copied') : _('Moved'));
			return;
		}
		ui.addNotification(null, E('div', {}, failed.map(function (f) {
			return E('p', {}, (f.path || '') + ': ' + errorMessage(f, _('failed')));
		})), 'error');
	},

	/* ------------------------------------------------------------ properties */

	actionProperties: function (entry) {
		var self = this;
		callStat(entry.path).then(function (st) {
			if (!st || st.ok === false) return notifyError(st, _('Cannot read properties'));
			var rows = [
				[_('Name'), st.name],
				[_('Path'), st.path],
				[_('Type'), classify(st)],
				[_('Size'), st.type === 'directory' ? '—' : fmtSize(st.size)],
				[_('Owner'), st.owner + ' (' + st.uid + ')'],
				[_('Group'), st.group + ' (' + st.gid + ')'],
				[_('Permissions'), st.mode_string + ' (' + st.mode_octal + ')'],
				[_('Modified'), fmtTime(st.mtime)],
				[_('Accessed'), fmtTime(st.atime)],
				[_('Changed'), fmtTime(st.ctime)],
				[_('Filesystem'), st.fstype + ' @ ' + st.mount]
			];
			if (st.is_symlink)
				rows.splice(3, 0, [_('Target'), st.symlink_target + (st.broken ? ' (' + _('broken') + ')' : '')]);

			ui.showModal(_('Properties'), [
				E('table', { class: 'table' }, rows.map(function (r) {
					return E('tr', { class: 'tr' }, [
						E('td', { class: 'td', style: 'font-weight:bold;width:35%' }, r[0]),
						E('td', { class: 'td' }, String(r[1]))
					]);
				})),
				E('div', { class: 'right', style: 'margin-top:1em' }, E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
			]);
		});
	},

	/* ----------------------------------------------------------- permissions */

	actionPermissions: function (entry) {
		var self = this;
		callStat(entry.path).then(function (st) {
			if (!st || st.ok === false) return notifyError(st, _('Cannot read permissions'));
			var octal = parseInt(st.mode_octal, 8);
			var bits = {
				ur: !!(octal & 0o400), uw: !!(octal & 0o200), ux: !!(octal & 0o100),
				gr: !!(octal & 0o040), gw: !!(octal & 0o020), gx: !!(octal & 0o010),
				or: !!(octal & 0o004), ow: !!(octal & 0o002), ox: !!(octal & 0o001)
			};
			var checks = {};
			function row(label, rKey, wKey, xKey) {
				checks[rKey] = E('input', { type: 'checkbox' }); checks[rKey].checked = bits[rKey];
				checks[wKey] = E('input', { type: 'checkbox' }); checks[wKey].checked = bits[wKey];
				checks[xKey] = E('input', { type: 'checkbox' }); checks[xKey].checked = bits[xKey];
				return E('tr', { class: 'tr' }, [
					E('td', { class: 'td' }, label),
					E('td', { class: 'td' }, checks[rKey]),
					E('td', { class: 'td' }, checks[wKey]),
					E('td', { class: 'td' }, checks[xKey])
				]);
			}
			var table = E('table', { class: 'table' }, [
				E('tr', { class: 'tr table-titles' }, [E('th', { class: 'th' }, ''), E('th', { class: 'th' }, _('Read')), E('th', { class: 'th' }, _('Write')), E('th', { class: 'th' }, _('Execute'))]),
				row(_('Owner'), 'ur', 'uw', 'ux'),
				row(_('Group'), 'gr', 'gw', 'gx'),
				row(_('Others'), 'or', 'ow', 'ox')
			]);
			var octalPreview = E('div', { style: 'margin-top:.5em;font-family:monospace' }, st.mode_octal);
			function recompute() {
				var m = (checks.ur.checked ? 0o400 : 0) | (checks.uw.checked ? 0o200 : 0) | (checks.ux.checked ? 0o100 : 0) |
					(checks.gr.checked ? 0o040 : 0) | (checks.gw.checked ? 0o020 : 0) | (checks.gx.checked ? 0o010 : 0) |
					(checks.or.checked ? 0o004 : 0) | (checks.ow.checked ? 0o002 : 0) | (checks.ox.checked ? 0o001 : 0);
				octalPreview.textContent = (m).toString(8).padStart(4, '0');
				return m;
			}
			Object.keys(checks).forEach(function (k) { checks[k].addEventListener('change', recompute); });

			var uidInput = E('input', { type: 'text', class: 'cbi-input-text', value: st.uid, style: 'width:6em' });
			var gidInput = E('input', { type: 'text', class: 'cbi-input-text', value: st.gid, style: 'width:6em' });

			ui.showModal(_('Permissions') + ': ' + entry.name, [
				table, octalPreview,
				E('div', { class: 'cbi-value', style: 'margin-top:1em' }, [
					E('label', { class: 'cbi-value-title' }, 'UID:'), uidInput, ' ',
					E('label', { class: 'cbi-value-title' }, 'GID:'), gidInput
				]),
				E('div', { class: 'right', style: 'margin-top:1em' }, [
					E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						class: 'btn cbi-button-action', click: function () {
							var mode = recompute();
							var ops = [callChmod(entry.path, mode)];
							var newUid = parseInt(uidInput.value, 10);
							var newGid = parseInt(gidInput.value, 10);
							if (newUid !== st.uid || newGid !== st.gid)
								ops.push(callChown(entry.path, isNaN(newUid) ? -1 : newUid, isNaN(newGid) ? -1 : newGid));
							ui.hideModal();
							Promise.all(ops).then(function (results) {
								var failed = results.filter(function (r) { return !r || r.ok === false; });
								if (failed.length) notifyError(failed[0], _('Cannot change permissions'));
								else notifyOk(_('Permissions updated'));
								self.refresh();
							});
						}
					}, _('Apply'))
				])
			]);
		});
	},

	/* -------------------------------------------------------------- preview */

	actionPreview: function (entry) {
		var self = this;
		callRead(entry.path, 'preview').then(function (reply) {
			if (!reply || reply.ok === false) {
				if (reply && reply.error && reply.error.code === 'EFBIG') {
					return self.previewTooLarge(entry);
				}
				return notifyError(reply, _('Cannot preview file'));
			}
			if (reply.is_binary) {
				var cls = classify(entry);
				if (cls === 'Image') return self.previewImage(entry);
				return self.previewBinaryNotice(entry);
			}
			var text = b64DecodeUtf8(reply.data);
			ui.showModal(entry.path, [
				E('pre', { class: 'fx-preview-pre' }, text),
				reply.truncated ? E('p', { class: 'fx-warn' }, _('Preview truncated at %s.').format(fmtSize(reply.size))) : '',
				E('div', { class: 'right', style: 'margin-top:1em' }, [
					E('button', { class: 'btn', click: function () { self.actionDownload(entry); } }, _('Download')),
					' ',
					E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
				])
			]);
		});
	},

	previewImage: function (entry) {
		var self = this;
		var url = self.downloadUrl(entry.path);
		ui.showModal(entry.path, [
			E('div', { style: 'text-align:center' }, E('img', { src: url, style: 'max-width:100%;max-height:60vh' })),
			E('div', { class: 'right', style: 'margin-top:1em' }, E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
		]);
	},

	previewBinaryNotice: function (entry) {
		var self = this;
		ui.showModal(entry.path, [
			E('p', {}, _('This is a binary file and cannot be previewed as text.')),
			E('div', { class: 'right', style: 'margin-top:1em' }, [
				E('button', { class: 'btn', click: function () { self.actionDownload(entry); } }, _('Download')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
			])
		]);
	},

	previewTooLarge: function (entry) {
		var self = this;
		ui.showModal(entry.path, [
			E('p', {}, _('File is too large for preview.')),
			E('div', { class: 'right', style: 'margin-top:1em' }, [
				E('button', { class: 'btn', click: function () { self.actionDownload(entry); } }, _('Download instead')),
				' ',
				E('button', {
					class: 'btn', click: function () {
						callRead(entry.path, 'head').then(function (r) {
							if (!r || r.ok === false) return notifyError(r);
							self.showHeadTail(entry, b64DecodeUtf8(r.data), _('First part'));
						});
					}
				}, _('Show first part')),
				' ',
				E('button', {
					class: 'btn', click: function () {
						callRead(entry.path, 'tail').then(function (r) {
							if (!r || r.ok === false) return notifyError(r);
							self.showHeadTail(entry, b64DecodeUtf8(r.data), _('Last part'));
						});
					}
				}, _('Show last part')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close'))
			])
		]);
	},

	showHeadTail: function (entry, text, label) {
		ui.showModal(entry.path + ' — ' + label, [
			E('pre', { class: 'fx-preview-pre' }, text),
			E('div', { class: 'right', style: 'margin-top:1em' }, E('button', { class: 'btn', click: ui.hideModal }, _('Close')))
		]);
	},

	/* ---------------------------------------------------------------- edit */

	actionEdit: function (entry) {
		var self = this;
		callRead(entry.path, 'edit').then(function (reply) {
			if (!reply || reply.ok === false) {
				if (reply && reply.error && reply.error.code === 'EFBIG')
					return ui.addNotification(null, E('p', {}, _('File is too large to edit (limit applies). Download it instead.')), 'warning');
				if (reply && reply.error && reply.error.code === 'EINVAL')
					return ui.addNotification(null, E('p', {}, _('This does not look like a text file.')), 'warning');
				return notifyError(reply, _('Cannot open file for editing'));
			}
			var original = b64DecodeUtf8(reply.data);
			var textarea = E('textarea', { class: 'fx-editor-textarea', spellcheck: 'false' }, original);
			var dirty = false;
			textarea.addEventListener('input', function () { dirty = true; });

			var mtime = reply.mtime, size = reply.size;

			function doSave(force) {
				var content = textarea.value;
				callWrite(entry.path, b64EncodeUtf8(content), 'base64', mtime, size, !!force).then(function (r) {
					if (!r || r.ok === false) {
						if (r && r.error && r.error.code === 'ECONFLICT') {
							ui.showModal(_('Conflict'), [
								E('p', {}, _('File has been modified externally. Overwrite anyway?')),
								E('div', { class: 'right' }, [
									E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
									' ',
									E('button', { class: 'btn cbi-button-negative', click: function () { ui.hideModal(); doSave(true); } }, _('Overwrite'))
								])
							]);
							return;
						}
						return notifyError(r, _('Save failed'));
					}
					dirty = false;
					mtime = r.mtime; size = r.size;
					notifyOk(_('Saved'));
				});
			}

			function closeEditor() {
				if (dirty) {
					ui.showModal(_('Unsaved changes'), [
						E('p', {}, _('You have unsaved changes. Discard them?')),
						E('div', { class: 'right' }, [
							E('button', { class: 'btn', click: function () { self.actionEdit(entry); } }, _('Back to editor')),
							' ',
							E('button', { class: 'btn cbi-button-negative', click: ui.hideModal }, _('Discard'))
						])
					]);
					return;
				}
				ui.hideModal();
			}

			textarea.addEventListener('keydown', function (ev) {
				if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
					ev.preventDefault();
					doSave(false);
				}
			});

			ui.showModal(entry.path, [
				textarea,
				E('div', { class: 'right', style: 'margin-top:1em' }, [
					E('button', { class: 'btn', click: closeEditor }, _('Cancel')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: function () { doSave(false); } }, _('Save'))
				])
			], 'fx-editor-modal');

			textarea.focus();
		});
	},

	/* -------------------------------------------------------------- download */

	downloadUrl: function (path) {
		return L.url('admin', 'system', 'filexplorer', 'download') + '?path=' + encodeURIComponent(path);
	},

	actionDownload: function (entry) {
		var a = E('a', { href: this.downloadUrl(entry.path), download: entry.name, style: 'display:none' });
		document.body.appendChild(a);
		a.click();
		window.setTimeout(function () { a.remove(); }, 1000);
	},

	/* ---------------------------------------------------------------- upload */

	actionUpload: function () {
		var self = this;
		pickDirectory(self.path).then(function (dest) {
			if (!dest) return;
			var input = E('input', { type: 'file', multiple: true, style: 'display:none' });
			document.body.appendChild(input);
			input.addEventListener('change', function () {
				var files = Array.prototype.slice.call(input.files || []);
				input.remove();
				if (!files.length) return;
				self.uploadFiles(files, dest);
			});
			input.click();
		});
	},

	uploadFiles: function (files, dest) {
		var self = this;
		var total = files.length;
		var idx = 0;

		var overallLabel = E('div', {}, _('%d / %d files').format(0, total));
		var fileLabel = E('div', { class: 'fx-upload-filename' }, '');
		var bar = E('div', { class: 'fx-progress-bar' }, E('div', { class: 'fx-progress-fill' }));
		var fill = bar.firstChild;
		var cancelled = false;
		var xhr = null;

		var modal = ui.showModal(_('Uploading…'), [
			overallLabel, fileLabel, bar,
			E('div', { class: 'right', style: 'margin-top:1em' }, E('button', {
				class: 'btn', click: function () { cancelled = true; if (xhr) xhr.abort(); ui.hideModal(); }
			}, _('Cancel')))
		]);

		function uploadNext() {
			if (cancelled) return;
			if (idx >= total) {
				ui.hideModal();
				notifyOk(_('Upload complete'));
				self.refresh();
				return;
			}
			var file = files[idx];
			fileLabel.textContent = file.name;
			overallLabel.textContent = _('%d / %d files').format(idx, total);
			fill.style.width = '0%';

			var fd = new FormData();
			fd.append('file', file, file.name);

			xhr = new XMLHttpRequest();
			xhr.open('POST', L.url('admin', 'system', 'filexplorer', 'upload') + '?dest=' + encodeURIComponent(dest) + '&overwrite=0');
			xhr.upload.addEventListener('progress', function (ev) {
				if (ev.lengthComputable)
					fill.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
			});
			xhr.onload = function () {
				if (cancelled) return;
				var resp = null;
				try { resp = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
				if (xhr.status === 200 && resp && resp.ok) {
					idx++;
					uploadNext();
				} else if (resp && resp.error && resp.error.code === 'EEXIST') {
					self.confirmOverwrite(1, function () {
						var fd2 = new FormData();
						fd2.append('file', file, file.name);
						var x2 = new XMLHttpRequest();
						x2.open('POST', L.url('admin', 'system', 'filexplorer', 'upload') + '?dest=' + encodeURIComponent(dest) + '&overwrite=1');
						x2.onload = function () { idx++; uploadNext(); };
						x2.onerror = function () { idx++; uploadNext(); };
						x2.send(fd2);
					});
				} else {
					ui.addNotification(null, E('p', {}, file.name + ': ' + errorMessage(resp, _('Upload failed'))), 'error');
					idx++;
					uploadNext();
				}
			};
			xhr.onerror = function () {
				if (cancelled) return;
				ui.addNotification(null, E('p', {}, file.name + ': ' + _('Upload failed')), 'error');
				idx++;
				uploadNext();
			};
			xhr.send(fd);
		}

		uploadNext();
	},

	/* ---------------------------------------------------------------- search */

	actionSearch: function (query, recursive) {
		var self = this;
		if (!query || !query.length) {
			self.renderTable();
			return;
		}
		callSearch(self.path, query, !!recursive, 500).then(function (reply) {
			if (!reply || reply.ok === false) return notifyError(reply, _('Search failed'));
			var list = reply.results;
			var thead = E('tr', { class: 'tr table-titles' }, [
				E('th', { class: 'th' }, _('Name')),
				E('th', { class: 'th' }, _('Path')),
				E('th', { class: 'th' }, _('Type')),
				E('th', { class: 'th' }, _('Size'))
			]);
			var rows = [thead];
			if (!list.length)
				rows.push(E('tr', { class: 'tr' }, E('td', { class: 'td', colspan: 4, style: 'padding:1em' }, _('No matches'))));
			list.forEach(function (entry) {
				rows.push(E('tr', { class: 'tr' }, [
					E('td', { class: 'td' }, E('span', { class: 'fx-name-link', click: function () { self.openEntry(entry); } }, iconFor(entry, classify(entry)) + ' ' + entry.name)),
					E('td', { class: 'td' }, dirName(entry.path)),
					E('td', { class: 'td' }, classify(entry)),
					E('td', { class: 'td' }, entry.type === 'directory' ? '—' : fmtSize(entry.size))
				]));
			});
			if (reply.truncated)
				rows.push(E('tr', { class: 'tr' }, E('td', { class: 'td', colspan: 4 }, _('Results truncated. Try a more specific query or a recursive search.'))));
			if (!recursive)
				rows.push(E('tr', { class: 'tr' }, E('td', { class: 'td', colspan: 4 }, E('a', { href: '#', click: function (ev) { ev.preventDefault(); self.actionSearch(query, true); } }, _('Search recursively…')))));
			dom.content(self.tableNode, rows);
		});
	}

});
