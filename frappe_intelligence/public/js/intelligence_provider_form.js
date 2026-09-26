/* The native Desk form is the provider UI. This script keeps it safe: it
   narrows Default Thinking Effort to the efforts the fetched catalog
   attributes to the active model (falling back to the full canonical set when
   the provider's catalog says nothing), edits the model catalog as removable
   chips over the newline-separated Small Text storage, notes per-model output
   ceilings under the chips, fetches the catalog through the app's whitelisted
   API, and rotates credentials through an endpoint that never echoes the key
   back. model_efforts arrives in two shapes: current rows map a model to an
   object ({efforts: [...], max_output: n}); legacy rows map it to a bare
   efforts array. Both are accepted everywhere. Everything degrades to a no-op
   when a frappe API is unavailable, and the write actions stay hidden when
   the user cannot save the record. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const __ = global.__ || ((text) => text);
	const CANONICAL_EFFORTS = ["Auto", "Low", "Medium", "High", "Max"];
	/* Mirrors provider_service.MODEL_ID; the server re-validates on save. */
	const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
	const CHIPS_ASSET = "/assets/frappe_intelligence/js/intelligence_chips.js";

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
	function effortList(entry) {
		/* Both stored shapes: a legacy bare array of efforts, or an object
		   carrying an efforts list (plus optionally max_output). */
		if (Array.isArray(entry)) return entry;
		if (entry && typeof entry === "object" && Array.isArray(entry.efforts)) return entry.efforts;
		return null;
	}
	function maxOutputOf(entry) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const value = Number(entry.max_output);
		return isFinite(value) && value > 0 ? value : null;
	}
	function formatOutputLimit(value) {
		/* 64000 reads as "64k"; smaller ceilings stay verbatim. */
		if (value >= 1000) return Math.round(value / 100) / 10 + "k";
		return String(value);
	}
	function effortOptions(modelEfforts, model) {
		const map = parseModelEfforts(modelEfforts);
		const advertised = map && typeof model === "string" ? effortList(map[model]) : null;
		if (advertised && advertised.length) {
			const allowed = CANONICAL_EFFORTS.filter(
				(effort) => effort !== "Auto" && advertised.indexOf(effort) !== -1
			);
			// Auto is always implied; unknown labels never reach the Select.
			if (allowed.length) return ["Auto"].concat(allowed);
		}
		return CANONICAL_EFFORTS.slice();
	}
	function modelLines(text) {
		/* Same convention as the server's catalog: trimmed non-empty lines,
		   de-duplicated with first occurrence winning. */
		const seen = {};
		const rows = [];
		String(text == null ? "" : text)
			.split("\n")
			.forEach(function (line) {
				const value = line.trim();
				if (value && !seen[value]) {
					seen[value] = true;
					rows.push(value);
				}
			});
		return rows;
	}
	function canSave(frm) {
		if (!frm || !frm.doc || !frm.doc.name) return false;
		if (typeof frm.is_new === "function" && frm.is_new()) return false;
		if (typeof frm.has_perm === "function") return !!frm.has_perm("write");
		const perm = frm.perm;
		return !!(perm && perm.length && perm[0] && perm[0].write);
	}
	function canWrite(frm) {
		return Boolean(frm && frm.perm && frm.perm[0] && frm.perm[0].write);
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
	function htmlField(frm, fieldname) {
		if (!frm || typeof frm.get_field !== "function") return null;
		const field = frm.get_field(fieldname);
		return field && field.wrapper ? field : null;
	}
	function paintModelMeta(frm) {
		/* Per-model output ceilings from the catalog metadata, muted under the
		   chips. Legacy bare-array rows carry no ceiling and render nothing. */
		const holder = htmlField(frm, "models_meta_html");
		if (!holder || typeof frm.set_df_property !== "function" || !global.$) return;
		const doc = frm.doc || {};
		const map = parseModelEfforts(doc.model_efforts);
		const box = global.$('<div class="small text-muted"></div>');
		let count = 0;
		if (map) {
			modelLines(doc.models).forEach(function (model) {
				const ceiling = maxOutputOf(map[model]);
				if (ceiling) {
					count += 1;
					box.append(
						global.$("<div></div>").text(model + ": up to " + formatOutputLimit(ceiling) + " output")
					);
				}
			});
		}
		holder.$wrapper.empty().append(box);
		frm.set_df_property("models_meta_html", "hidden", count ? 0 : 1);
	}
	function acceptModelRows(frm, editor, rows) {
		const valid = [];
		const rejected = [];
		(rows || []).forEach(function (row) {
			(MODEL_ID.test(row) ? valid : rejected).push(row);
		});
		if (rejected.length) {
			/* setRows bypasses the change pipeline, so this never re-enters. */
			editor.setRows(valid);
			const frappe = global.frappe;
			if (frappe && typeof frappe.show_alert === "function")
				frappe.show_alert({
					message: __("Ignored invalid model IDs: {0}", [rejected.join(", ")]),
					indicator: "red",
				});
		}
		if (fi.chips && typeof frm.set_value === "function")
			frm.set_value("models", fi.chips.joinLines(valid));
	}
	function syncModels(frm, editor) {
		const c = fi.chips;
		if (!c) return;
		const next = c.parseLines(frm.doc && frm.doc.models);
		if (c.joinLines(editor.getRows()) !== c.joinLines(next)) editor.setRows(next);
	}
	function setupModelChips(frm) {
		const c = fi.chips;
		if (!c || !frm || typeof frm.set_df_property !== "function") return;
		const holder = htmlField(frm, "models_chips");
		let editor = frm.__fi_models_editor || null;
		if (editor && !(editor.control.$wrapper.get(0) || {}).isConnected) {
			editor = null; // form re-rendered; the old control went with the old DOM
			frm.__fi_models_editor = null;
		}
		if (!editor && holder) {
			const docfield = typeof frm.get_docfield === "function" ? frm.get_docfield("models") : null;
			editor = c.makeChipEditor({
				parent: holder.wrapper,
				fieldname: "models_chips",
				label: docfield && docfield.label,
				description: docfield && docfield.description,
				placeholder: __("Type a model ID, Enter to add"),
				onChange: function (rows) {
					acceptModelRows(frm, editor, rows);
				},
			});
			if (editor) frm.__fi_models_editor = editor;
		}
		if (!editor) return;
		/* The chips are the editor now; the Small Text becomes hidden storage
		   that keeps its exact value until a chip changes. */
		frm.set_df_property("models", "hidden", 1);
		frm.set_df_property("models_chips", "hidden", 0);
		syncModels(frm, editor);
		editor.setReadOnly(!canWrite(frm));
	}
	function setupModelCatalog(frm) {
		/* The chip factory ships in intelligence_chips.js, which hooks loads
		   for the settings and skill forms; on the provider form it is fetched
		   once through frappe's own asset loader. Without it the raw Small
		   Text stays the editor. */
		const frappe = global.frappe;
		if (fi.chips) {
			setupModelChips(frm);
		} else if (frappe && typeof frappe.require === "function" && !frm.__fi_chips_requested) {
			frm.__fi_chips_requested = true;
			try {
				Promise.resolve(frappe.require(CHIPS_ASSET)).then(
					function () {
						/* frappe.require resolves even when the asset failed, so
						   re-check the factory before wiring the editor. */
						if (fi.chips && frm.doc) setupModelChips(frm);
					},
					function () {}
				);
			} catch (error) {}
		}
		paintModelMeta(frm);
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
				if (frm.__fi_models_editor) syncModels(frm, frm.__fi_models_editor);
				applyEffortOptions(frm);
				paintModelMeta(frm);
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
				setupModelCatalog(frm);
				const isNew = typeof frm.is_new === "function" && frm.is_new();
				// The key is write-only: visible and required while the record is
				// unsaved (nothing exists to read back), hidden the moment it exists.
				if (typeof frm.set_df_property === "function") {
					frm.set_df_property("api_key", "hidden", isNew ? 0 : 1);
					frm.set_df_property("api_key", "reqd", isNew ? 1 : 0);
				}
				if (typeof frm.set_intro === "function")
					frm.set_intro(
						isNew
							? __("The API key is stored server-side and is never displayed after saving.")
							: __("The API key is stored server-side and is never displayed. Use Set API key to set or rotate it."),
						"blue"
					);
				if (!canSave(frm) || typeof frm.add_custom_button !== "function") return;
				frm.add_custom_button(__("Fetch models"), () => fetchModels(frm));
				frm.add_custom_button(__("Set API key"), () => setApiKey(frm));
			},
			model(frm) {
				applyEffortOptions(frm);
			},
			models(frm) {
				if (frm.__fi_models_editor) syncModels(frm, frm.__fi_models_editor);
				paintModelMeta(frm);
			},
			model_efforts(frm) {
				applyEffortOptions(frm);
				paintModelMeta(frm);
			},
		});
		return true;
	}
	registerProviderForm(global);
	Object.assign(fi, {
		parseModelEfforts,
		effortList,
		maxOutputOf,
		formatOutputLimit,
		effortOptions,
		modelLines,
		canSave,
		registerProviderForm,
	});
});
