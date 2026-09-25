/* The native Desk form is the provider UI. This script keeps it safe: it
   narrows Thinking Effort to the efforts the fetched catalog attributes to the
   active model (falling back to the full canonical set when the provider's
   catalog says nothing), fetches the catalog through the app's whitelisted
   API, and rotates credentials through an endpoint that never echoes the key
   back. Everything degrades to a no-op when a frappe API is unavailable, and
   the write actions stay hidden when the user cannot save the record. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const __ = global.__ || ((text) => text);
	const CANONICAL_EFFORTS = ["Auto", "Low", "Medium", "High", "Max"];
	function parseModelEfforts(raw) {
		if (raw && typeof raw === "object") return raw;
		if (typeof raw !== "string" || !raw.trim()) return null;
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
		} catch (error) {
			return null;
		}
	}
	function effortOptions(modelEfforts, model) {
		const map = parseModelEfforts(modelEfforts);
		const advertised = map && typeof model === "string" ? map[model] : null;
		if (Array.isArray(advertised) && advertised.length) {
			const allowed = CANONICAL_EFFORTS.filter(
				(effort) => effort !== "Auto" && advertised.indexOf(effort) !== -1
			);
			// Auto is always implied; unknown labels never reach the Select.
			if (allowed.length) return ["Auto"].concat(allowed);
		}
		return CANONICAL_EFFORTS.slice();
	}
	function canSave(frm) {
		if (!frm || !frm.doc || !frm.doc.name) return false;
		if (typeof frm.is_new === "function" && frm.is_new()) return false;
		if (typeof frm.has_perm === "function") return !!frm.has_perm("write");
		const perm = frm.perm;
		return !!(perm && perm.length && perm[0] && perm[0].write);
	}
	function applyEffortOptions(frm) {
		if (!frm || typeof frm.set_df_property !== "function") return;
		const doc = frm.doc || {};
		frm.set_df_property(
			"thinking_effort",
			"options",
			effortOptions(doc.model_efforts, doc.model).join("\n")
		);
	}
	function fetchModels(frm) {
		const frappe = global.frappe;
		if (!frappe || typeof frappe.call !== "function" || !frm || !frm.doc || !frm.doc.name) return;
		frappe.call({
			method: "frappe_intelligence.api.fetch_provider_models",
			args: { name: frm.doc.name },
			callback(response) {
				const data = (response && response.message) || {};
				const models = Array.isArray(data.models) ? data.models : [];
				if (typeof frm.set_value === "function") {
					frm.set_value("models", models.join("\n"));
					if (data.efforts && typeof data.efforts === "object")
						frm.set_value("model_efforts", JSON.stringify(data.efforts));
				}
				applyEffortOptions(frm);
				if (typeof frappe.show_alert === "function")
					frappe.show_alert({
						message: __("{0} models fetched from the provider.", [models.length]),
						indicator: "green",
					});
			},
		});
	}
	function setApiKey(frm) {
		const frappe = global.frappe;
		if (!frappe || typeof frappe.prompt !== "function" || typeof frappe.call !== "function") return;
		if (!frm || !frm.doc || !frm.doc.name) return;
		frappe.prompt(
			[
				{
					fieldname: "api_key",
					label: __("API key"),
					fieldtype: "Password",
					reqd: 1,
					description: __("The key is stored server-side and is never displayed."),
				},
			],
			(values) => {
				const key = values && typeof values.api_key === "string" ? values.api_key : "";
				if (!key.trim()) return;
				frappe.call({
					method: "frappe_intelligence.api.set_provider_api_key",
					args: { name: frm.doc.name, api_key: key },
					callback() {
						// The alert confirms the write; the key itself is never shown.
						if (typeof frappe.show_alert === "function")
							frappe.show_alert({
								message: __("API key saved. It is stored server-side and never displayed."),
								indicator: "green",
							});
					},
				});
			},
			__("Set API key"),
			__("Save")
		);
	}
	function registerProviderForm(g) {
		const frappe = g && g.frappe;
		if (!frappe || !frappe.ui || !frappe.ui.form || typeof frappe.ui.form.on !== "function")
			return false;
		frappe.ui.form.on("Intelligence Provider", {
			refresh(frm) {
				applyEffortOptions(frm);
				if (typeof frm.set_intro === "function")
					frm.set_intro(
						__(
							"The API key is stored server-side and is never displayed. Use Set API key to set or rotate it."
						),
						"blue"
					);
				if (!canSave(frm) || typeof frm.add_custom_button !== "function") return;
				frm.add_custom_button(__("Fetch models"), () => fetchModels(frm));
				frm.add_custom_button(__("Set API key"), () => setApiKey(frm));
			},
			model(frm) {
				applyEffortOptions(frm);
			},
			model_efforts(frm) {
				applyEffortOptions(frm);
			},
		});
		return true;
	}
	registerProviderForm(global);
	Object.assign(fi, { parseModelEfforts, effortOptions, canSave, registerProviderForm });
});
