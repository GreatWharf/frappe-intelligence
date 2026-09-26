/* Intelligence Memory form: clear the conversation link when scope leaves
   conversation (the server rejects a stale link), a live character counter on
   content, and a native maxlength ceiling. The scope-driven show/hide of the
   conversation link itself is declarative (depends_on in the doctype), so it
   works even when this script does not load. All handlers no-op safely when a
   frappe API is missing. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const CONTENT_LIMIT = 5000;
	const CONTENT_NOTE = "The assistant sees this text verbatim when the memory is recalled.";

	function __(text, args) {
		const translate = global.__;
		if (typeof translate === "function") return translate(text, args);
		return String(text).replace(/\{(\d+)\}/g, function (match, index) {
			return args && args[index] != null ? String(args[index]) : match;
		});
	}

	function contentField(frm) {
		const field = frm.get_field("content");
		return field || null;
	}

	function updateCounter(frm, liveText) {
		const field = contentField(frm);
		if (!field || typeof field.set_new_description !== "function") return;
		/* liveText comes straight from the textarea during typing; the doc
		   model lags by frappe's debounced change event. */
		const text = liveText != null ? liveText : frm.doc.content;
		const length = String(text || "").length;
		field.set_new_description(
			__("{0} / {1} characters. {2}", [String(length), String(CONTENT_LIMIT), __(CONTENT_NOTE)])
		);
	}

	function setupCounter(frm) {
		const field = contentField(frm);
		if (!field) return;
		const area = field.$textarea || field.$input;
		/* The flag lives on the element, not the form: a re-rendered textarea
		   is a fresh element and gets bound again. */
		if (area && area.length && !area.data("fiCounterBound")) {
			area.data("fiCounterBound", true);
			area.attr("maxlength", CONTENT_LIMIT);
			area.on("input.fi-memory-counter", function () {
				updateCounter(frm, this.value);
			});
		}
		updateCounter(frm);
	}

	function clearStaleConversation(frm) {
		if (frm.doc.scope !== "conversation" && frm.doc.conversation) {
			frm.set_value("conversation", "");
		}
	}

	function canDelete(frm) {
		if (!frm || !frm.doc || !frm.doc.name) return false;
		if (typeof frm.is_new === "function" && frm.is_new()) return false;
		if (typeof frm.has_perm === "function") return !!frm.has_perm("write");
		const perm = frm.perm;
		return !!(perm && perm.length && perm[0] && perm[0].write);
	}

	function deleteMemory(frm) {
		const frappe = global.frappe;
		if (!frappe || typeof frappe.call !== "function" || !frm || !frm.doc || !frm.doc.name) return;
		const name = frm.doc.name;
		const drop = function () {
			frappe.call({
				method: "frappe_intelligence.api.delete_memory",
				args: { name: name },
				callback() {
					if (typeof frappe.set_route === "function") {
						frappe.set_route("List", "Intelligence Memory");
					}
				},
			});
		};
		/* Memory records carry no delete permission by design (generic REST must
		   not remove them); the whitelisted endpoint applies the owner and
		   manager rules, so the form offers exactly that path. */
		if (typeof frappe.confirm === "function") {
			frappe.confirm(__("Delete this memory permanently?"), drop);
		} else {
			drop();
		}
	}

	function registerMemoryForm(g) {
		const frappe = g && g.frappe;
		if (!frappe || !frappe.ui || !frappe.ui.form || typeof frappe.ui.form.on !== "function") {
			return false;
		}
		frappe.ui.form.on("Intelligence Memory", {
			refresh(frm) {
				setupCounter(frm);
				if (canDelete(frm) && typeof frm.add_custom_button === "function") {
					frm.add_custom_button(__("Delete"), function () {
						deleteMemory(frm);
					});
				}
			},
			scope(frm) {
				clearStaleConversation(frm);
			},
			content(frm) {
				updateCounter(frm);
			},
		});
		return true;
	}

	registerMemoryForm(global);
	Object.assign(fi, {
		memoryForm: {
			contentLimit: CONTENT_LIMIT,
			contentNote: CONTENT_NOTE,
			updateCounter: updateCounter,
			clearStaleConversation: clearStaleConversation,
			canDelete: canDelete,
			deleteMemory: deleteMemory,
			registerMemoryForm: registerMemoryForm,
		},
	});
});
