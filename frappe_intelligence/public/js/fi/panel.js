/* Intelligence panel: global Desk surface (launcher pill, contextual drawer, persistence). */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi;
	if (!fi) throw new Error("Intelligence core must load before panel");
	const { App, LOGO, contextFromRoute, trapFocus } = fi;
	const STORAGE_KEY = "fi-panel-state";
	const DEFAULT_WIDTH = 420, MIN_WIDTH = 360, VIEWPORT_MARGIN = 80, FULL_BLEED_MAX = 480;
	let toggle, drawer, drawerFocus, pendingConversation = null, resizing = null;
	function clampDrawerWidth(width, viewport) {
		const size = Number(viewport);
		const max = size > 0 ? Math.max(MIN_WIDTH, size - VIEWPORT_MARGIN) : Infinity;
		const value = Number(width);
		if (!Number.isFinite(value)) return DEFAULT_WIDTH;
		return Math.min(Math.max(Math.round(value), MIN_WIDTH), max);
	}
	// Panel state lives in localStorage; every read is defensive so a corrupt or
	// stale payload can never break Desk boot.
	function readState() {
		const fallback = { open: false, width: DEFAULT_WIDTH, conversation: null };
		try {
			const storage = global.localStorage;
			if (!storage) return fallback;
			const raw = storage.getItem(STORAGE_KEY);
			if (!raw) return fallback;
			const data = JSON.parse(raw);
			if (!data || typeof data !== "object") return fallback;
			return {
				open: !!data.open,
				width: clampDrawerWidth(data.width === undefined ? DEFAULT_WIDTH : data.width, global.innerWidth),
				conversation: typeof data.conversation === "string" && data.conversation ? data.conversation : null
			};
		} catch (_) { return fallback; }
	}
	function writeState(patch) {
		const next = Object.assign(readState(), patch || {});
		try { const storage = global.localStorage; if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) { /* storage can be blocked; the panel still works */ }
		return next;
	}
	function drawerVisible() { return !!(drawer && !drawer.hidden); }
	function syncToggles(expanded) { if (toggle) toggle.setAttribute("aria-expanded", expanded ? "true" : "false"); }
	function hideDrawerChrome() { if (drawer) { drawer.hidden = true; drawer.classList.remove("is-open"); } syncToggles(false); writeState({ open: false }); }
	// The floating pill stays available across Desk except on the Intelligence page
	// itself, where the full app already fills the content area. syncDesk is called
	// on install, on every route change and from the page lifecycle.
	function syncDesk() {
		if (!fi.deskReady()) return;
		if (toggle) toggle.hidden = fi.routeIsPage();
		const stale = global.document.querySelector("[data-fi-desk]"); if (stale) stale.remove();
		if (global.document.body) global.document.body.classList.toggle("fi-desk-active", fi.routeIsPage());
	}
	function animateOpen() {
		if (!drawer) return;
		drawer.classList.remove("is-open");
		const raf = global.requestAnimationFrame ? global.requestAnimationFrame.bind(global) : (fn) => global.setTimeout(fn, 16);
		raf(() => { if (drawer && !drawer.hidden) drawer.classList.add("is-open"); });
	}
	// A conversation parked in panel state is selected through the same path a
	// conversation row uses, but only once it is known to exist in the loaded list.
	function restoreConversation(app) {
		if (!pendingConversation || !app) return;
		if (app.selected === pendingConversation) { pendingConversation = null; return; }
		const rows = Array.isArray(app.conversations) ? app.conversations : [];
		if (!rows.some((row) => row && row.name === pendingConversation)) return;
		const name = pendingConversation;
		pendingConversation = null;
		app.select(name);
	}
	function persistSelection(app) { if (drawerVisible()) writeState({ conversation: app.selected || null }); }
	// At phone widths the drawer is full-bleed (CSS owns the width there), so no
	// inline width is applied or persisted below FULL_BLEED_MAX.
	function fullBleed() { return Number(global.innerWidth) > 0 && global.innerWidth <= FULL_BLEED_MAX; }
	function applyWidth(width) {
		if (!drawer) return;
		if (fullBleed()) { drawer.style.width = ""; return; }
		drawer.style.width = clampDrawerWidth(width, global.innerWidth) + "px";
	}
	function endResize() {
		if (!resizing) return;
		const session = resizing; resizing = null;
		const doc = global.document;
		if (doc && typeof doc.removeEventListener === "function") {
			doc.removeEventListener("mousemove", session.move);
			doc.removeEventListener("mouseup", session.up);
			doc.removeEventListener("pointermove", session.move);
			doc.removeEventListener("pointerup", session.up);
			doc.removeEventListener("pointercancel", session.up);
		}
		if (typeof global.removeEventListener === "function") global.removeEventListener("blur", session.up);
		if (drawer) drawer.classList.remove("is-resizing");
	}
	function startResize(event) {
		if (!drawer || drawer.hidden || resizing || fullBleed()) return;
		if (event.button !== undefined && event.button !== 0) return;
		if (event.preventDefault) event.preventDefault();
		// Pointer capture keeps the drag alive when the cursor leaves the window;
		// test hosts without it fall back to the document-level listeners below.
		if (event.pointerId !== undefined && event.currentTarget && event.currentTarget.setPointerCapture) {
			try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* unsupported host */ }
		}
		const startX = event.clientX;
		const rect = drawer.getBoundingClientRect ? drawer.getBoundingClientRect() : null;
		const startWidth = (rect && rect.width) || parseFloat(drawer.style.width) || DEFAULT_WIDTH;
		drawer.classList.add("is-resizing");
		let width = startWidth;
		const move = (moveEvent) => {
			if (moveEvent.clientX === undefined) return;
			width = clampDrawerWidth(startWidth + (startX - moveEvent.clientX), global.innerWidth);
			applyWidth(width);
		};
		const up = () => { endResize(); writeState({ width: clampDrawerWidth(width, global.innerWidth) }); };
		resizing = { move, up };
		const doc = global.document;
		if (doc && typeof doc.addEventListener === "function") {
			doc.addEventListener("mousemove", move);
			doc.addEventListener("mouseup", up);
			doc.addEventListener("pointermove", move);
			doc.addEventListener("pointerup", up);
			doc.addEventListener("pointercancel", up);
		}
		// Releasing outside the window never reaches document; a blur ends the drag.
		if (typeof global.addEventListener === "function") global.addEventListener("blur", up);
	}
	function keyResize(event) {
		const step = { ArrowLeft: 24, ArrowRight: -24 }[event.key];
		if (!step || !drawer || drawer.hidden) return;
		if (event.preventDefault) event.preventDefault();
		const rect = drawer.getBoundingClientRect ? drawer.getBoundingClientRect() : null;
		const current = (rect && rect.width) || parseFloat(drawer.style.width) || DEFAULT_WIDTH;
		const width = clampDrawerWidth(current + step, global.innerWidth);
		applyWidth(width);
		writeState({ width });
	}
	function createDrawer(app) {
		drawer = global.document.createElement("div");
		drawer.className = "fi-drawer-shell";
		drawer.hidden = true;
		drawer.setAttribute("role", "dialog");
		drawer.setAttribute("aria-modal", "true");
		drawer.setAttribute("aria-label", "Intelligence contextual drawer");
		drawer.tabIndex = -1;
		drawer.addEventListener("keydown", (event) => { if (event.key === "Tab") trapFocus(event, drawer); if (event.key === "Escape" && !app.modal) { event.preventDefault(); closeDrawer(); } });
		const strip = global.document.createElement("div");
		strip.className = "fi-drawer-resize";
		strip.tabIndex = 0;
		strip.setAttribute("role", "separator");
		strip.setAttribute("aria-orientation", "vertical");
		strip.setAttribute("aria-label", "Resize panel");
		strip.title = "Drag to resize (Arrow keys)";
		strip.addEventListener("pointerdown", startResize);
		strip.addEventListener("mousedown", startResize);
		strip.addEventListener("keydown", keyResize);
		drawer.appendChild(strip);
		global.document.body.appendChild(drawer);
	}
	function openDrawer() {
		if (!fi.deskReady()) return;
		const app = fi.getApp();
		if (drawer && !drawer.hidden) { closeDrawer(); return; }
		if (!drawer) createDrawer(app);
		applyWidth(readState().width);
		drawerFocus = global.document.activeElement;
		drawer.hidden = false;
		app.context = contextFromRoute(global.frappe.get_route());
		app.show(drawer, "drawer");
		syncToggles(true);
		drawer.focus();
		global.setTimeout(() => { if (!drawer.hidden) app.$("textarea").focus(); }, 0);
		writeState({ open: true });
		if (!pendingConversation) pendingConversation = readState().conversation;
		restoreConversation(app);
		animateOpen();
	}
	function closeDrawer() {
		if (!drawer || drawer.hidden) return;
		endResize();
		drawer.classList.remove("is-open");
		drawer.hidden = true;
		writeState({ open: false });
		syncToggles(false);
		const app = fi.currentApp();
		if (app) { const host = fi.pageHost(); if (host && fi.routeIsPage()) app.show(host, "page"); else app.hide(); }
		if (drawerFocus && drawerFocus.isConnected) drawerFocus.focus();
	}
	function isEditable(node) {
		if (!node || !node.tagName) return false;
		const tag = String(node.tagName).toLowerCase();
		if (tag === "input" || tag === "textarea" || tag === "select") return true;
		if (node.isContentEditable) return true;
		const host = node.closest ? node.closest("[contenteditable]") : null;
		return !!(host && String(host.getAttribute("contenteditable")).toLowerCase() !== "false");
	}
	function shortcutToggle(event) {
		// Ctrl+I is italic in Desk text editors: never steal it from an editable.
		if (isEditable(event && event.target) || isEditable(global.document && global.document.activeElement)) return;
		if (event && event.preventDefault) event.preventDefault();
		openDrawer();
	}
	function installShortcut() {
		const keys = global.frappe && global.frappe.ui && global.frappe.ui.keys;
		let registered = false;
		if (keys && typeof keys.add_shortcut === "function") {
			try { keys.add_shortcut({ shortcut: "ctrl+i", action: shortcutToggle, description: "Toggle Intelligence" }); registered = true; } catch (_) { registered = false; }
		}
		if (!registered) global.document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && !event.shiftKey && String(event.key || "").toLowerCase() === "i") shortcutToggle(event); });
	}
	function installPanel() {
		if (toggle) return;
		toggle = global.document.createElement("button");
		toggle.type = "button";
		toggle.className = "fi-global-toggle";
		toggle.setAttribute("aria-label", "Open Intelligence");
		toggle.setAttribute("aria-expanded", "false");
		toggle.title = "Intelligence (Ctrl+I)";
		toggle.innerHTML = '<img class="fi-toggle-logo" src="' + LOGO + '" alt="" aria-hidden="true"><span>Intelligence</span>';
		toggle.addEventListener("click", openDrawer);
		global.document.body.appendChild(toggle);
		installShortcut();
		// Ctrl/Cmd+Shift+I stays as an always-on alias, even inside text editors.
		global.document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key || "").toLowerCase() === "i") { event.preventDefault(); openDrawer(); } });
		// Boot restores geometry and the parked conversation only; state.open is
		// recorded for later lifecycle use and never auto-opens the drawer here.
		pendingConversation = readState().conversation;
	}
	// Persist the parked conversation whenever the selection changes while the
	// drawer is open, and retry a parked selection once the list has loaded.
	const coreSelect = App.prototype.select;
	App.prototype.select = function (name) {
		const result = coreSelect.call(this, name);
		persistSelection(this);
		return result;
	};
	const coreNewConversation = App.prototype.newConversation;
	App.prototype.newConversation = function () {
		const result = coreNewConversation.call(this);
		persistSelection(this);
		return result;
	};
	const coreRefreshList = App.prototype.refreshList;
	App.prototype.refreshList = function () {
		const result = coreRefreshList.apply(this, arguments);
		return Promise.resolve(result).then((value) => { if (drawerVisible()) restoreConversation(this); return value; });
	};
	Object.assign(fi, {
		syncDesk, openDrawer, closeDrawer, drawerVisible, hideDrawerChrome, installPanel,
		toggle: openDrawer, close: closeDrawer,
		clampDrawerWidth, panelState: { read: readState, write: writeState }
	});
});
