/* Desk compatibility shims: guarded patches for upstream frappe bugs.

   frappe v16's SidebarHeader.add_app_item renders the app-switcher row icon as
   item.icon ? frappe.utils.icon(item.icon) : '<img class="logo" src="${item.icon_url}">'
   but sibling-workspace items built by fetch_related_icons()/get_icon_for_menu_item()
   may carry icon_html (an inline SVG letter glyph) with no icon_url, which renders
   a literal src="undefined" and fires a wasted request on every Desk boot
   (/undefined 404 on root-level pages, /desk/undefined 200 catch-all under /desk/*).

   The patch below replaces the method ONLY while its live source still has the
   buggy shape (references icon_url, never icon_html). Once upstream reads
   icon_html the shim detects the fixed shape and leaves frappe's own code alone.
   Reference: frappe/public/js/frappe/ui/sidebar/sidebar_header.js (add_app_item,
   fetch_related_icons, get_icon_for_menu_item). */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const MARK = "__fiIconGuard";

	function getSidebarHeader(g) {
		return g && g.frappe && g.frappe.ui && g.frappe.ui.SidebarHeader;
	}

	function looksBuggy(source) {
		return (
			typeof source === "string" &&
			source.indexOf("icon_url") !== -1 &&
			source.indexOf("icon_html") === -1
		);
	}

	function appendRow(dropdownMenu, html) {
		if (!dropdownMenu) return;
		if (typeof dropdownMenu.append === "function") {
			// jQuery object (SidebarHeader.make assigns this.wrapper.find(".sidebar-header-menu"))
			dropdownMenu.append(html);
		} else if (typeof dropdownMenu.appendChild === "function" && dropdownMenu.ownerDocument) {
			const template = dropdownMenu.ownerDocument.createElement("template");
			template.innerHTML = html.trim();
			if (template.content.firstChild) dropdownMenu.appendChild(template.content.firstChild);
		}
	}

	function makeAddAppItem(g) {
		// Faithful reimplementation of upstream add_app_item (same classes, data
		// attributes and shortcut label so setup_select_options keeps binding by
		// .dropdown-menu-item + data-name), plus the icon_html fallback branch.
		return function add_app_item(item) {
			const frappe = g.frappe;
			const iconHtml = item.icon
				? frappe.utils.icon(item.icon)
				: item.icon_url
					? `<img class="logo" src="${item.icon_url}">`
					: item.icon_html || "";
			const shortcutHtml = item.shortcut
				? `<span class="menu-item-shortcut">${frappe.ui.keys.get_shortcut_label(item.shortcut)}</span>`
				: "";
			appendRow(
				this.dropdown_menu,
				`<div class="dropdown-menu-item" data-name="${item.name}" data-app-route="${item.route}">
	<a ${item.href ? `href="${item.href}"` : ""}>
		<div class="sidebar-item-icon">${iconHtml}</div>
		<span class="menu-item-title">${item.label}</span>
		${shortcutHtml}
	</a>
</div>`
			);
		};
	}

	// Returns "patched" | "already" | "clean" | "absent" so callers and tests can
	// tell a successful guard from a fixed-upstream or a not-yet-loaded bundle.
	function patchDeskIconGuard(g) {
		const SidebarHeader = getSidebarHeader(g);
		if (!SidebarHeader || !SidebarHeader.prototype) return "absent";
		const current = SidebarHeader.prototype.add_app_item;
		if (typeof current !== "function") return "absent";
		if (current[MARK]) return "already";
		if (!looksBuggy(String(current))) return "clean";
		const replacement = makeAddAppItem(g);
		replacement[MARK] = true;
		SidebarHeader.prototype.add_app_item = replacement;
		return "patched";
	}

	// App includes load after the desk bundle, so the patch lands before the
	// lazily populated sidebar menu renders. If some boot order loads us first,
	// retry once when the document is ready.
	if (patchDeskIconGuard(global) === "absent" && global.document && global.document.addEventListener) {
		global.document.addEventListener("DOMContentLoaded", () => patchDeskIconGuard(global), { once: true });
	}

	Object.assign(fi, { patchDeskIconGuard, deskIconGuardMarker: MARK });
});
