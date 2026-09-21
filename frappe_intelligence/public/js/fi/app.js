/* Intelligence app: boot, routing, page mode. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi;
	if (!fi) throw new Error("Intelligence core must load before app");
	const { App, PAGE, contextFromRoute } = fi;
	let singleton, installed = false, hostPage;
	function getApp() {
		if (!singleton) {
			singleton = new App(); singleton.onClose = fi.closeDrawer;
			// Hand off to the full page on the same conversation, parking it so the
			// next drawer open lands back where the user left.
			singleton.onExpand = () => { const name = singleton.selected || null; if (fi.panelState) fi.panelState.write({ conversation: name }); fi.closeDrawer(); if (name) global.frappe.set_route(PAGE, name); else global.frappe.set_route(PAGE); };
		}
		return singleton;
	}
	function deskReady() { return !!(global.document && global.frappe && global.frappe.boot && global.frappe.session && global.frappe.session.user && global.frappe.session.user !== "Guest" && global.frappe.get_route); }
	function pageRoute() { const route = global.frappe.get_route(); return route && route[0] === PAGE ? route : null; }
	function routeIsPage() { return !!pageRoute(); }
	function syncRouteSelection() {
		if (!singleton) return;
		const route = pageRoute();
		if (!route) return;
		const name = route[1] || null;
		if (name && name !== singleton.selected) singleton.select(name);
		else if (!name && singleton.selected) singleton.newConversation();
	}
	function showPage(host) { if (!deskReady()) return; hostPage = host.jquery ? host[0] : host; fi.hideDrawerChrome(); const app = getApp(); app.show(hostPage, "page"); fi.syncDesk(); syncRouteSelection(); }
	function install() {
		if (installed || !deskReady()) return; installed = true;
		fi.installPanel();
		const routeChange = () => { fi.syncDesk(); if (!singleton) return; if (fi.drawerVisible()) { singleton.context = contextFromRoute(global.frappe.get_route()); singleton.renderContext(); } else if (routeIsPage()) syncRouteSelection(); else singleton.hide(); };
		if (global.frappe.router && global.frappe.router.on) global.frappe.router.on("change", routeChange);
		fi.syncDesk();
		fi.subscribeRealtime((event) => { if (!singleton || !event || !event.conversation) return; if (singleton.visible || singleton.watched.has(event.conversation)) { singleton.lastList = 0; singleton.poller.start(100); } });
		global.addEventListener("online", () => { if (singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
		global.document.addEventListener("visibilitychange", () => { if (!global.document.hidden && singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
		global.addEventListener("pagehide", () => { if (singleton) singleton.poller.stop(); });
		global.addEventListener("pageshow", () => { if (singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
	}
	Object.assign(fi, { getApp, deskReady, pageRoute, routeIsPage, syncRouteSelection, showPage, install, currentApp: () => singleton, pageHost: () => hostPage });
});
