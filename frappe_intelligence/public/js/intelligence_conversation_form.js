/* Intelligence Conversation has no useful Form view of its own: the chat page
   is the conversation UI. Any route that still lands on the Form (global-search
   and awesomebar hits both emit ["Form", doctype, name]) bounces straight to
   the chat page, the same pattern core uses in access_log.js. The list view
   never lands here because doctype_list_js rewrites row links directly. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	function conversationFormRoute(name) {
		return ["intelligence", name];
	}
	function registerConversationFormRedirect(g) {
		const frappe = g && g.frappe;
		if (!frappe || !frappe.ui || !frappe.ui.form || typeof frappe.ui.form.on !== "function") return false;
		frappe.ui.form.on("Intelligence Conversation", {
			onload(frm) {
				frappe.set_route.apply(frappe, conversationFormRoute(frm.doc.name));
			},
		});
		return true;
	}
	registerConversationFormRedirect(global);
	Object.assign(fi, { conversationFormRoute, registerConversationFormRedirect });
});
