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

	function registerMemoryForm(g) {
		const frappe = g && g.frappe;
		if (!frappe || !frappe.ui || !frappe.ui.form || typeof frappe.ui.form.on !== "function") {
			return false;
		}
		frappe.ui.form.on("Intelligence Memory", {
			refresh(frm) {
				setupCounter(frm);
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
			registerMemoryForm: registerMemoryForm,
		},
	});
});
