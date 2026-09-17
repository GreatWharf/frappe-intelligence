/* The application bundle is loaded through app_include_js; this file owns only Desk page lifecycle. */
frappe.pages["intelligence-chat"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: __("Intelligence"), single_column: true });
	const host = document.createElement("div");
	host.className = "fi-page-host";
	const main = page.main && page.main[0] ? page.main[0] : wrapper;
	main.classList.add("fi-native-main");
	main.appendChild(host);
	wrapper.intelligence_host = host;
	if (frappe.intelligence) {
		frappe.intelligence.install();
		frappe.intelligence.showPage(host);
	} else {
		host.textContent = __("Intelligence could not load. Refresh Desk or contact your system manager.");
	}
};
frappe.pages["intelligence-chat"].on_page_show = function (wrapper) {
	if (frappe.intelligence && wrapper.intelligence_host) {
		frappe.intelligence.install();
		frappe.intelligence.showPage(wrapper.intelligence_host);
	}
};
