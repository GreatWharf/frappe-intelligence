/* The application bundle is loaded through app_include_js; this file owns only Desk page lifecycle. */
(function () {
	// Deep links land on /desk/intelligence/<conversation>, a route with no sidebar
	// candidate of its own; pin the seeded Intelligence sidebar so the rail never
	// falls back to a stale or "Getting Started" module.
	function activateSidebar() {
		try {
			const sidebar = frappe.app && frappe.app.sidebar;
			if (sidebar && typeof sidebar.show_sidebar_for_module === "function") sidebar.show_sidebar_for_module("Intelligence");
		} catch (error) { /* sidebar chrome is best-effort */ }
	}
	// Core renders the app title as the sidebar header subtitle whenever
	// app_name_style is configured, duplicating an identical header title
	// ("Intelligence" over "Intelligence"). Hide only exact duplicates; the
	// observer re-applies this because core re-renders the header on every
	// sidebar switch.
	let observer = null;
	function dedupSubtitle() {
		try {
			const header = document.querySelector(".body-sidebar .sidebar-header");
			if (!header) return;
			const title = header.querySelector(".header-title"), subtitle = header.querySelector(".header-subtitle");
			if (!title || !subtitle) return;
			const name = title.textContent.trim();
			subtitle.hidden = name !== "" && name === subtitle.textContent.trim();
		} catch (error) { /* cosmetic only */ }
	}
	function watchHeader() {
		if (observer || typeof MutationObserver !== "function") return;
		const rail = document.querySelector(".body-sidebar");
		if (!rail) return;
		observer = new MutationObserver(dedupSubtitle);
		observer.observe(rail, { childList: true, subtree: true });
	}
	function chrome() {
		activateSidebar();
		dedupSubtitle();
		// The header can render after the page lifecycle fires; re-check on the
		// next frame and keep the observer retrying until the rail exists.
		const again = () => { watchHeader(); dedupSubtitle(); };
		if (window.requestAnimationFrame) window.requestAnimationFrame(again);
		else setTimeout(again, 0);
	}
	frappe.pages["intelligence"].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Intelligence"), single_column: true });
		const host = document.createElement("div");
		host.className = "fi-page-host";
		const main = page.main && page.main[0] ? page.main[0] : wrapper;
		main.classList.add("fi-native-main");
		main.appendChild(host);
		wrapper.intelligence_host = host;
		chrome();
		if (frappe.intelligence) {
			frappe.intelligence.install();
			frappe.intelligence.showPage(host, page);
		} else {
			host.textContent = __("Intelligence could not load. Refresh Desk or contact your system manager.");
		}
	};
	frappe.pages["intelligence"].on_page_show = function (wrapper) {
		chrome();
		if (frappe.intelligence && wrapper.intelligence_host) {
			frappe.intelligence.install();
			frappe.intelligence.showPage(wrapper.intelligence_host);
		}
	};
})();
