/* Shared chip editors for the Intelligence doctype forms. A native
   MultiSelectPills control (the same control the core Assign To dialog uses)
   sits in a hidden-until-needed HTML field and round-trips against a
   newline-separated Small Text field, which stays the stored value. The
   Small Text is only hidden once a working editor exists, so the raw text
   remains the fallback editor whenever a frappe API is missing. The skills
   catalog doubles as the tool/scope reference: it lists every assembled
   tool with its description plus the site's read/write DocType scopes, and
   it is whitelisted for every Intelligence user. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});

	function parseLines(text) {
		/* Same convention as the server's policy_lines: trimmed non-empty
		   lines, de-duplicated with first occurrence winning. */
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

	function joinLines(rows) {
		return (rows || []).join("\n");
	}

	function searchOptions(doctype, txt, filters) {
		/* Link-field style autocomplete against frappe.desk.search.search_link.
		   DocType search ignores permissions server-side, so every Desk user
		   gets name completion. Any failure resolves to no suggestions; free
		   entry keeps working. */
		const frappe = global.frappe;
		if (!frappe || !frappe.db || typeof frappe.db.get_link_options !== "function") {
			return Promise.resolve([]);
		}
		try {
			return Promise.resolve(
				frappe.db.get_link_options(doctype, txt || "", filters || {}, 20)
			).then(
				function (rows) {
					return Array.isArray(rows) ? rows : [];
				},
				function () {
					return [];
				}
			);
		} catch (err) {
			return Promise.resolve([]);
		}
	}

	let catalogPromise = null;
	function fetchCatalog() {
		/* frappe_intelligence.api.skills, fetched once per session: tool names
		   and descriptions plus the site's read/write scopes. No secrets. */
		const frappe = global.frappe;
		if (!frappe || typeof frappe.call !== "function") return Promise.resolve(null);
		if (!catalogPromise) {
			catalogPromise = new Promise(function (resolve) {
				try {
					frappe.call({
						method: "frappe_intelligence.api.skills",
						callback: function (r) {
							resolve((r && r.message) || null);
						},
						error: function () {
							resolve(null);
						},
					});
				} catch (err) {
					resolve(null);
				}
			});
		}
		return catalogPromise;
	}

	function toolOptions(catalog) {
		const tools = (catalog && catalog.tools) || [];
		return tools
			.filter(function (tool) {
				return tool && tool.name;
			})
			.map(function (tool) {
				return { value: tool.name, label: tool.name, description: tool.description || "" };
			});
	}

	function nameOptions(names) {
		return (names || []).map(function (name) {
			return { value: name, label: name };
		});
	}

	/* A native MultiSelectPills control over an in-memory row list. Returns
	   null when the control stack is unavailable; callers then leave the raw
	   Small Text field visible as the editor. opts: parent, fieldname, label,
	   description, placeholder, getData(txt) -> promise/array, onChange(rows). */
	function makeChipEditor(opts) {
		const frappe = global.frappe;
		if (
			!frappe ||
			!frappe.ui ||
			!frappe.ui.form ||
			typeof frappe.ui.form.make_control !== "function" ||
			!frappe.ui.form.ControlMultiSelectPills ||
			!opts ||
			!opts.parent
		) {
			return null;
		}
		const df = {
			fieldtype: "MultiSelectPills",
			fieldname: opts.fieldname || "chips",
			label: opts.label,
			description: opts.description,
			placeholder: opts.placeholder || "",
		};
		if (typeof opts.getData === "function") {
			df.get_data = function (txt) {
				return opts.getData(txt || "");
			};
		}
		/* No doc/doctype/frm binding on purpose: the control stays an in-memory
		   editor, and every add/remove/blur reaches df.onchange. */
		let control;
		try {
			control = frappe.ui.form.make_control({ df: df, parent: opts.parent, render_input: true });
		} catch (err) {
			return null;
		}
		if (!control || !control.$wrapper) return null;
		let readOnly = false;
		function applyReadOnly() {
			control.$wrapper.find(".btn-remove").toggle(!readOnly);
			if (control.$input) control.$input.prop("disabled", readOnly);
		}
		const editor = {
			control: control,
			setRows: function (rows) {
				/* Direct render, bypassing the change pipeline: seeding must never
				   fire onChange or rewrite the stored field. */
				control.set_formatted_input(Array.isArray(rows) ? rows.slice() : []);
				if (control.$input) control.$input.val("");
				applyReadOnly();
			},
			getRows: function () {
				const rows = control.get_values ? control.get_values() : control.rows;
				return (rows || []).slice();
			},
			setReadOnly: function (value) {
				readOnly = !!value;
				applyReadOnly();
			},
		};
		if (typeof opts.onChange === "function") {
			df.onchange = function () {
				if (!readOnly) opts.onChange(editor.getRows());
			};
		}
		return editor;
	}

	Object.assign(fi, {
		chips: {
			parseLines: parseLines,
			joinLines: joinLines,
			searchOptions: searchOptions,
			fetchCatalog: fetchCatalog,
			toolOptions: toolOptions,
			nameOptions: nameOptions,
			makeChipEditor: makeChipEditor,
		},
	});
});
