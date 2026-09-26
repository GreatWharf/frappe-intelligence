/* Intelligence Settings form: chip editors over the five newline-separated
   scope fields, a read-only context retrieval (RAG) status banner fed by the
   boot payload, and friendly client-side scope checks. The server validates
   everything again on save; these handlers only make the Desk form nicer.
   Every step degrades to the raw Small Text fields when an API is missing. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const CHIP_FIELDS = [
		"allowed_read_doctypes",
		"allowed_write_doctypes",
		"enabled_tools",
		"allowed_reports",
		"allowed_custom_hosts",
	];

	function chips() {
		return fi.chips || null;
	}

	function __(text, args) {
		const translate = global.__;
		if (typeof translate === "function") return translate(text, args);
		return String(text).replace(/\{(\d+)\}/g, function (match, index) {
			return args && args[index] != null ? String(args[index]) : match;
		});
	}

	function escapeHtml(text) {
		const frappe = global.frappe;
		if (frappe && frappe.utils && typeof frappe.utils.escape_html === "function") {
			return frappe.utils.escape_html(text);
		}
		return String(text).replace(/[&<>"]/g, function (ch) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
		});
	}

	function canWrite(frm) {
		return Boolean(frm && frm.perm && frm.perm[0] && frm.perm[0].write);
	}

	function htmlField(frm, fieldname) {
		const field = frm.get_field(fieldname);
		return field && field.wrapper ? field : null;
	}

	function chipSpec(frm, fieldname, editors) {
		const c = chips();
		const specs = {
			allowed_read_doctypes: {
				getData: function (txt) {
					return c.searchOptions("DocType", txt, { istable: 0 });
				},
			},
			allowed_write_doctypes: {
				getData: function () {
					/* Writable is a subset of readable: suggest the current read
					   chips so a valid entry is always one click away. */
					const read = editors.allowed_read_doctypes;
					const rows = read
						? read.getRows()
						: c.parseLines(frm.doc.allowed_read_doctypes);
					return Promise.resolve(c.nameOptions(rows));
				},
			},
			enabled_tools: {
				getData: function () {
					return c.fetchCatalog().then(function (catalog) {
						return c.toolOptions(catalog);
					});
				},
			},
			allowed_reports: {
				getData: function (txt) {
					return c.searchOptions("Report", txt);
				},
			},
			allowed_custom_hosts: {},
		};
		return specs[fieldname] || {};
	}

	function syncEditor(frm, fieldname, editor) {
		const c = chips();
		const next = c.parseLines(frm.doc[fieldname]);
		if (c.joinLines(editor.getRows()) !== c.joinLines(next)) {
			editor.setRows(next);
		}
	}

	function setupChipEditors(frm) {
		const c = chips();
		if (!c || !frm.get_docfield) return;
		const editors = (frm.__fi_chips = frm.__fi_chips || {});
		CHIP_FIELDS.forEach(function (fieldname) {
			const docfield = frm.get_docfield(fieldname);
			const holder = htmlField(frm, fieldname + "_chips");
			let editor = editors[fieldname];
			if (editor && !(editor.control.$wrapper.get(0) || {}).isConnected) {
				editor = null; // form re-rendered; the old control went with the old DOM
				delete editors[fieldname];
			}
			if (!editor && holder) {
				const spec = chipSpec(frm, fieldname, editors);
				editor = c.makeChipEditor({
					parent: holder.wrapper,
					fieldname: fieldname + "_chips",
					label: docfield && docfield.label,
					description: docfield && docfield.description,
					placeholder: __("Type to search, Enter to add"),
					getData: spec.getData,
					onChange: function (rows) {
						frm.set_value(fieldname, c.joinLines(rows));
					},
				});
				if (editor) editors[fieldname] = editor;
			}
			if (editor) {
				/* The chips are the editor now; the Small Text becomes hidden
				   storage that keeps its exact value until a chip changes. */
				frm.set_df_property(fieldname, "hidden", 1);
				frm.set_df_property(fieldname + "_chips", "hidden", 0);
				syncEditor(frm, fieldname, editor);
				editor.setReadOnly(!canWrite(frm));
			}
		});
	}

	function ragMessage(rag) {
		/* Colors are form-message suffixes: green and blue carry styling, and
		   text-muted renders the neutral grey used for every state that is a
		   deliberate configuration rather than a problem. */
		if (rag && rag.available) {
			if (rag.mode === "lexical") {
				return {
					color: "blue",
					text: __(
						"Context retrieval is on: keyword matching (no embeddings endpoint on the configured providers)."
					),
				};
			}
			/* Payloads without a mode predate the split and only reported
			   available when embeddings worked, so they mean semantic. */
			let text = __("Context retrieval is on: semantic search");
			if (rag.provider) text += " " + __("through {0}", [escapeHtml(rag.provider)]);
			if (rag.model) text += " (" + escapeHtml(rag.model) + ")";
			return { color: "green", text: text + "." };
		}
		if (rag && rag.reason) {
			return {
				color: "text-muted",
				text: __("Context retrieval is off: {0}", [escapeHtml(rag.reason)]),
			};
		}
		return {
			color: "text-muted",
			text: __("Context retrieval status could not be determined."),
		};
	}

	function paintRagStatus(frm) {
		const holder = htmlField(frm, "rag_status_html");
		if (!holder) return;
		const message = ragMessage(frm.__fi_rag);
		holder.$wrapper.html(
			'<div class="form-message ' + message.color + '">' + message.text + "</div>"
		);
		frm.set_df_property("rag_status_html", "hidden", 0);
	}

	function loadRagStatus(frm) {
		const frappe = global.frappe;
		if (!frappe || typeof frappe.call !== "function") return;
		if (frm.__fi_rag_requested) {
			if (frm.__fi_rag !== undefined) paintRagStatus(frm);
			return;
		}
		frm.__fi_rag_requested = true; /* one bootstrap call per form instance */
		try {
			frappe.call({
				method: "frappe_intelligence.api.bootstrap",
				callback: function (r) {
					frm.__fi_rag = (r && r.message && r.message.rag) || null;
					paintRagStatus(frm);
				},
				error: function () {
					frm.__fi_rag = null;
					paintRagStatus(frm);
				},
			});
		} catch (err) {
			frm.__fi_rag = null;
		}
	}

	function validateScopes(frm) {
		const frappe = global.frappe;
		const c = chips();
		if (!frappe || typeof frappe.throw !== "function" || !c) return;
		const read = {};
		c.parseLines(frm.doc.allowed_read_doctypes).forEach(function (name) {
			read[name] = true;
		});
		const missing = c
			.parseLines(frm.doc.allowed_write_doctypes)
			.filter(function (name) {
				return !read[name];
			});
		if (missing.length) {
			frappe.throw(
				__("Add {0} to Allowed Read Doctypes before making it writable.", [
					escapeHtml(missing.join(", ")),
				])
			);
		}
		const badHosts = c
			.parseLines(frm.doc.allowed_custom_hosts)
			.filter(function (host) {
				return /[\s/:*@?#]/.test(host);
			});
		if (badHosts.length) {
			frappe.throw(
				__(
					"Custom provider hosts must be exact hostnames without URLs, ports or wildcards: {0}.",
					[escapeHtml(badHosts.join(", "))]
				)
			);
		}
	}

	function registerSettingsForm(g) {
		const frappe = g && g.frappe;
		if (!frappe || !frappe.ui || !frappe.ui.form || typeof frappe.ui.form.on !== "function") {
			return false;
		}
		frappe.ui.form.on("Intelligence Settings", {
			refresh(frm) {
				setupChipEditors(frm);
				loadRagStatus(frm);
			},
			validate(frm) {
				validateScopes(frm);
			},
		});
		return true;
	}

	registerSettingsForm(global);
	Object.assign(fi, {
		settingsForm: {
			chipFields: CHIP_FIELDS,
			ragMessage: ragMessage,
			validateScopes: validateScopes,
			registerSettingsForm: registerSettingsForm,
		},
	});
});
