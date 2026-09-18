/* Intelligence panel: global Desk surface (launcher pill, contextual drawer). */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi;
	if (!fi) throw new Error("Intelligence core must load before panel");
	const { LOGO, contextFromRoute, trapFocus } = fi;
	let toggle, drawer, drawerFocus;
	function drawerVisible() { return !!(drawer && !drawer.hidden); }
	function hideDrawerChrome() { if (drawer) drawer.hidden = true; if (toggle) toggle.setAttribute("aria-expanded", "false"); }
	// The floating pill stays available across Desk except on the Intelligence page
	// itself, where the full app already fills the content area. syncDesk is called
	// on install, on every route change and from the page lifecycle.
	function syncDesk() {
		if (!fi.deskReady()) return;
		if (toggle) toggle.hidden = fi.routeIsPage();
		const stale = global.document.querySelector("[data-fi-desk]"); if (stale) stale.remove();
		if (global.document.body) global.document.body.classList.toggle("fi-desk-active", fi.routeIsPage());
	}
	function openDrawer() {
		if (!fi.deskReady()) return; const app = fi.getApp(); if (drawer && !drawer.hidden) { closeDrawer(); return; }
		if (!drawer) { drawer = global.document.createElement("div"); drawer.className = "fi-drawer-shell"; drawer.hidden = true; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); drawer.setAttribute("aria-label", "Intelligence contextual drawer"); drawer.tabIndex = -1; drawer.addEventListener("keydown", (event) => { if (event.key === "Tab") trapFocus(event, drawer); if (event.key === "Escape" && !app.modal) { event.preventDefault(); closeDrawer(); } }); global.document.body.appendChild(drawer); }
		drawerFocus = global.document.activeElement; drawer.hidden = false; app.context = contextFromRoute(global.frappe.get_route()); app.show(drawer, "drawer"); if (toggle) toggle.setAttribute("aria-expanded", "true"); drawer.focus(); global.setTimeout(() => { if (!drawer.hidden) app.$("textarea").focus(); }, 0);
	}
	function closeDrawer() { if (!drawer || drawer.hidden) return; drawer.hidden = true; if (toggle) toggle.setAttribute("aria-expanded", "false"); const app = fi.currentApp(); if (app) { const host = fi.pageHost(); if (host && fi.routeIsPage()) app.show(host, "page"); else app.hide(); } if (drawerFocus && drawerFocus.isConnected) drawerFocus.focus(); }
	function installPanel() {
		toggle = global.document.createElement("button"); toggle.type = "button"; toggle.className = "fi-global-toggle"; toggle.setAttribute("aria-label", "Open Intelligence"); toggle.setAttribute("aria-expanded", "false"); toggle.title = "Intelligence · Ctrl/⌘ Shift I"; toggle.innerHTML = '<img class="fi-toggle-logo" src="' + LOGO + '" alt="" aria-hidden="true"><span>Intelligence</span>'; toggle.addEventListener("click", openDrawer); global.document.body.appendChild(toggle);
		global.document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") { event.preventDefault(); openDrawer(); } });
	}
	Object.assign(fi, { syncDesk, openDrawer, closeDrawer, drawerVisible, hideDrawerChrome, installPanel, toggle: openDrawer, close: closeDrawer });
});
