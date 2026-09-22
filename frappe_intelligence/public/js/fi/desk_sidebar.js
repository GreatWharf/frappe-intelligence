/* Recent chats inside the native Desk sidebar.

   The v16 sidebar owns .sidebar-items and rebuilds it on every workspace
   switch, so this module never replaces anything frappe renders: after each
   native rebuild of the Intelligence sidebar it injects one extra Section
   Break ("Recent chats") with up to eight native link items pointing at
   /desk/intelligence/<conversation>, using the exact markup sidebar_item.html
   renders for workspace rows. Rebuilds fire no router event, so a
   MutationObserver on .sidebar-items re-injects the section whenever a wipe
   removed it while the Intelligence sidebar is showing. Data comes from
   frappe_intelligence.api.list_conversations (the same call the app page
   makes); App.refreshList pushes live updates through fi.deskSidebar.sync so
   renames, archives and new chats appear without waiting for a navigation.
   The section is skipped outside the Intelligence sidebar, in the sidebar
   editor and when the user has no conversations. Collapse state mirrors the
   native Section Break affordance, persisted in the same localStorage bucket
   frappe uses. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const SECTION = "Recent chats";
	const MARKER = "data-fi-recent-chats";
	const LIMIT = 8;
	let ticket = 0;
	let scheduled = false;
	let booted = false;
	let fetching = false;
	let observer = null;
	let lastSignature = null;

	function sidebar() {
		const frappe = global.frappe;
		if (!frappe || !frappe.app || !frappe.app.sidebar) return null;
		const desk = frappe.app.sidebar;
		if (String(desk.sidebar_title || "").toLowerCase() !== "intelligence") return null;
		if (desk.editor && desk.editor.edit_mode) return null;
		return desk;
	}

	function container() {
		return global.document ? global.document.querySelector(".sidebar-items") : null;
	}

	function sectionNode() {
		const items = container();
		return items ? items.querySelector("[" + MARKER + "]") : null;
	}

	function iconHtml(name) {
		const frappe = global.frappe;
		try {
			if (frappe && frappe.utils && typeof frappe.utils.icon === "function") return frappe.utils.icon(name, "sm") || "";
		} catch (_) { /* icon rendering is decorative */ }
		return "";
	}

	function el(doc, tag, className, text) {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function decorateContainer(node, title) {
		node.setAttribute("item-name", title);
		node.setAttribute("data-id", title);
		node.setAttribute("title", title);
		node.setAttribute("data-toggle", "tooltip");
		node.setAttribute("data-placement", "right");
	}

	// The same shape sidebar_item.html renders for a Link row, indented like a
	// native nested item under its Section Break.
	function chatItem(doc, row) {
		const title = String(row.title || "Conversation");
		const wrap = el(doc, "div", "sidebar-item-container");
		decorateContainer(wrap, title);
		const standard = el(doc, "div", "standard-sidebar-item indent");
		const anchor = el(doc, "a", "item-anchor");
		anchor.setAttribute("href", "/desk/intelligence/" + encodeURIComponent(String(row.name)));
		const icon = el(doc, "span", "sidebar-item-icon text-ink-gray-7");
		icon.setAttribute("item-icon", "message");
		const glyph = iconHtml("message");
		if (glyph) { try { icon.innerHTML = glyph; } catch (_) { /* plain span */ } }
		anchor.appendChild(icon);
		anchor.appendChild(el(doc, "span", "sidebar-item-label", title));
		anchor.appendChild(el(doc, "div", "sidebar-item-control"));
		standard.appendChild(anchor);
		wrap.appendChild(standard);
		wrap.appendChild(el(doc, "div", "sidebar-child-item nested-container"));
		return wrap;
	}

	// The native bucket sidebar_item.js TypeSectionBreak persists to, keyed by
	// lowercased workspace title and then the section's own title.
	function readState() {
		try {
			const raw = global.localStorage && global.localStorage.getItem("section-breaks-state");
			const all = raw ? JSON.parse(raw) : {};
			return !!(all.intelligence && all.intelligence[SECTION]);
		} catch (_) { return false; }
	}

	function writeState(collapsed) {
		try {
			const raw = global.localStorage && global.localStorage.getItem("section-breaks-state");
			const all = raw ? JSON.parse(raw) : {};
			if (!all.intelligence) all.intelligence = {};
			all.intelligence[SECTION] = collapsed;
			global.localStorage.setItem("section-breaks-state", JSON.stringify(all));
		} catch (_) { /* storage is advisory */ }
	}

	function applyCollapse(root, collapsed) {
		const nested = root.querySelector(".nested-container");
		const button = root.querySelector(".drop-icon");
		if (nested) nested.classList.toggle("hidden", collapsed);
		if (button) {
			button.setAttribute("data-state", collapsed ? "closed" : "opened");
			button.setAttribute("aria-expanded", String(!collapsed));
			const glyph = iconHtml(collapsed ? "chevron-right" : "chevron-down");
			if (glyph) { try { button.innerHTML = glyph; } catch (_) { /* keep the previous glyph */ } }
		}
	}

	function buildSection(doc, rows) {
		const root = el(doc, "div", "sidebar-item-container section-item");
		decorateContainer(root, SECTION);
		root.setAttribute(MARKER, "1");
		const standard = el(doc, "div", "standard-sidebar-item");
		standard.appendChild(el(doc, "div", "divider hidden"));
		const head = el(doc, "div", "item-anchor section-break");
		head.appendChild(el(doc, "span", "sidebar-item-label", SECTION));
		const control = el(doc, "div", "sidebar-item-control");
		const toggle = el(doc, "button", "btn-reset drop-icon");
		toggle.setAttribute("type", "button");
		toggle.setAttribute("aria-label", "Collapse or expand recent chats");
		control.appendChild(toggle);
		head.appendChild(control);
		standard.appendChild(head);
		root.appendChild(standard);
		const nested = el(doc, "div", "sidebar-child-item nested-container");
		rows.forEach((row) => nested.appendChild(chatItem(doc, row)));
		root.appendChild(nested);
		standard.addEventListener("click", () => {
			const next = !nested.classList.contains("hidden");
			applyCollapse(root, next);
			writeState(next);
		});
		return root;
	}

	function markActive(root) {
		const path = String((global.location && global.location.pathname) || "").replace(/\/$/, "");
		Array.from(root.querySelectorAll("a.item-anchor")).forEach((anchor) => {
			const href = String(anchor.getAttribute("href") || "").replace(/\/$/, "");
			const active = !!href && (path === href || path.indexOf(href + "/") === 0);
			if (anchor.parentNode) anchor.parentNode.classList.toggle("active-sidebar", active);
		});
	}

	function place(items, root) {
		const anchorItem = items.querySelector('[data-id="Conversations"]');
		if (anchorItem && anchorItem.parentNode === items && typeof anchorItem.after === "function") anchorItem.after(root);
		else if (anchorItem && anchorItem.parentNode === items) items.insertBefore(root, anchorItem.nextSibling);
		else items.appendChild(root);
	}

	function signatureOf(list) {
		// Titles are single-line, so a newline join keeps pairs unambiguous.
		return list.map((row) => String(row.name) + ":" + String(row.title || "")).join("\n");
	}

	function render(rows) {
		const desk = sidebar();
		if (!desk) return false;
		const items = container();
		if (!items) return false;
		const list = (Array.isArray(rows) ? rows : []).filter((row) => row && row.name).slice(0, LIMIT);
		const signature = signatureOf(list);
		const existing = sectionNode();
		if (!list.length) {
			if (existing) existing.remove();
			lastSignature = null;
			return true;
		}
		if (existing && signature === lastSignature) {
			markActive(existing);
			return true;
		}
		if (existing) existing.remove();
		const root = buildSection(global.document, list);
		place(items, root);
		applyCollapse(root, readState());
		markActive(root);
		lastSignature = signature;
		try { if (typeof desk.set_active_workspace_item === "function") desk.set_active_workspace_item(); } catch (_) { /* native refresh is advisory */ }
		return true;
	}

	function fetchRows(done) {
		const frappe = global.frappe;
		if (!frappe || typeof frappe.call !== "function") { done(null); return; }
		let settled = false;
		const finish = (rows) => { if (!settled) { settled = true; done(rows); } };
		try {
			const pending = frappe.call({
				method: "frappe_intelligence.api.list_conversations",
				args: { archived: 0 },
				silent: true,
				callback: (response) => finish(response && !response.exc && Array.isArray(response.message) ? response.message : null),
				error: () => finish(null)
			});
			if (pending && typeof pending.catch === "function") pending.catch(() => finish(null));
		} catch (_) { finish(null); }
	}

	// frappe rebuilds .sidebar-items on every workspace switch without any
	// router event, so route changes alone cannot keep the section alive: watch
	// the container and re-inject whenever a rebuild wiped it while the
	// Intelligence sidebar is showing.
	function observe(items) {
		if (observer) observer.disconnect();
		observer = null;
		if (typeof global.MutationObserver !== "function") return;
		observer = new global.MutationObserver(() => {
			if (!sidebar()) return;
			if (sectionNode()) return;
			schedule();
		});
		observer.observe(items, { childList: true });
	}

	function ensure() {
		scheduled = false;
		const items = container();
		if (items) observe(items);
		if (!sidebar()) return;
		if (!items) return;
		if (sectionNode()) return;
		if (fetching) return;
		const mine = ++ticket;
		fetching = true;
		fetchRows((rows) => {
			fetching = false;
			if (mine !== ticket) return;
			if (!Array.isArray(rows) || !rows.length) return;
			render(rows);
		});
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		global.setTimeout(ensure, 0);
	}

	function sync(rows) {
		++ticket;
		if (!sidebar()) return;
		render(rows);
	}

	function refresh() {
		++ticket;
		const existing = sectionNode();
		if (existing) existing.remove();
		lastSignature = null;
		schedule();
	}

	// The rail (collapsed sidebar) hides native section labels behind dividers
	// and opens every section; mirror that so the injected section behaves
	// exactly like the rows frappe rendered.
	function mirrorExpand(expanded) {
		const root = sectionNode();
		if (!root) return;
		const header = root.querySelector(".section-break");
		const divider = root.querySelector(".divider");
		const nested = root.querySelector(".nested-container");
		if (expanded === false) {
			if (header) header.classList.add("hidden");
			if (divider) divider.classList.remove("hidden");
			if (nested) nested.classList.remove("hidden");
		} else if (expanded === true) {
			if (header) header.classList.remove("hidden");
			if (divider) divider.classList.add("hidden");
			applyCollapse(root, readState());
		}
	}

	function boot() {
		if (booted) return;
		booted = true;
		const frappe = global.frappe;
		if (frappe && frappe.router && typeof frappe.router.on === "function") {
			try { frappe.router.on("change", schedule); } catch (_) { /* router unavailable */ }
		}
		if (global.jQuery && global.document) {
			try {
				const jq = global.jQuery(global.document);
				if (jq && typeof jq.on === "function") {
					jq.on("app_ready.fiDeskSidebar", schedule);
					jq.on("sidebar-expand.fiDeskSidebar", (event, data) => mirrorExpand(data && data.sidebar_expand));
				}
			} catch (_) { /* jQuery host missing */ }
		}
		schedule();
	}

	if (global.document) {
		if (global.document.readyState === "loading" && global.document.addEventListener) global.document.addEventListener("DOMContentLoaded", boot, { once: true });
		else if (global.setTimeout) global.setTimeout(boot, 0);
	}

	Object.assign(fi, { deskSidebar: { ensure: schedule, refresh, sync } });
});
