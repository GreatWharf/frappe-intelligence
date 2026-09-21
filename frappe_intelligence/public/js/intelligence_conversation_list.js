/* Intelligence Conversation list rows open the chat page, not a Form view: the
   chat page is the real conversation UI. frappe's ListView calls
   this.settings.get_form_link(doc) for every row subject link when the hook
   supplies it (frappe/public/js/frappe/list/list_view.js get_form_link), and
   doctype list scripts land here via hooks doctype_list_js ->
   frappe.listview_settings["Intelligence Conversation"]. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	function conversationRoute(name) {
		return "/desk/intelligence/" + encodeURIComponent(name);
	}
	const settings = {
		get_form_link(doc) {
			return conversationRoute(doc.name);
		},
	};
	if (global.frappe) {
		global.frappe.listview_settings = global.frappe.listview_settings || {};
		global.frappe.listview_settings["Intelligence Conversation"] = settings;
	}
	Object.assign(fi, { conversationRoute, conversationListSettings: settings });
});
