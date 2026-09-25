/* Intelligence Skill form: chip editors over the newline-separated scope
   fields, with DocType completion from the site's own read allowance (the
   skills catalog), and a friendly writable-subset check that the server
   repeats on save. The raw Small Text fields stay as the fallback editor
   whenever an API is missing. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const CHIP_FIELDS = ["scope_read", "scope_write"];

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

	function readScopeOptions(txt) {
		/* Complete against the site's Allowed Read Doctypes: a skill can never
		   widen past the site policy, so valid entries live in that list.
		   Falls back to a plain DocType search when the catalog is absent. */
		const c = chips();
		return c.fetchCatalog().then(function (catalog) {
			const names = catalog && catalog.scopes && catalog.scopes.read;
			if (names && names.length) return c.nameOptions(names);
			return c.searchOptions("DocType", txt, { istable: 0 });
		});
	}

	function setupChipEditors(frm) {
		const c = chips();
		if (!c || !frm.get_docfield) return;
		const editors = (frm.__fi_chips = frm.__fi_chips || {});
		CHIP_FIELDS.forEach(function (fieldname) {
			const docfield = frm.get_docfield(fieldname);
			const holder = frm.get_field(fieldname + "_chips");
			let editor = editors[fieldname];
			if (editor && !(editor.control.$wrapper.get(0) || {}).isConnected) {
				editor = null; // form re-rendered; the old control went with the old DOM
				delete editors[fieldname];
			}
			if (!editor && holder && holder.wrapper) {
				const getData =
					fieldname === "scope_read"
						? readScopeOptions
						: function (txt) {
								/* Writable is a subset of readable: suggest the
								   current read chips first. */
								const read = editors.scope_read;
								const rows = read ? read.getRows() : c.parseLines(frm.doc.scope_read);
								if (rows.length) return Promise.resolve(c.nameOptions(rows));
								return readScopeOptions(txt);
						  };
				editor = c.makeChipEditor({
					parent: holder.wrapper,
					fieldname: fieldname + "_chips",
					label: docfield && docfield.label,
					description: docfield && docfield.description,
					placeholder: __("Type to search, Enter to add"),
					getData: getData,
					onChange: function (rows) {
						frm.set_value(fieldname, c.joinLines(rows));
					},
				});
				if (editor) editors[fieldname] = editor;
			}
			if (editor) {
				frm.set_df_property(fieldname, "hidden", 1);
				frm.set_df_property(fieldname + "_chips", "hidden", 0);
				const next = c.parseLines(frm.doc[fieldname]);
				if (c.joinLines(editor.getRows()) !== c.joinLines(next)) {
					editor.setRows(next);
				}
				editor.setReadOnly(!canWrite(frm));
			}
		});
	}

	function validateScopes(frm) {
		const frappe = global.frappe;
		const c = chips();
		if (!frappe || typeof frappe.throw !== "function" || !c) return;
		const read = {};
		c.parseLines(frm.doc.scope_read).forEach(function (name) {
			read[name] = true;
		});
		const missing = c.parseLines(frm.doc.scope_write).filter(function (name) {
			return !read[name];
		});
		if (missing.length) {
			frappe.throw(
				__("Add {0} to Scope Read before making it writable.", [
					escapeHtml(missing.join(", ")),
				])
			);
		}
	}

	function registerSkillForm(g) {
		const frappe = g && g.frappe;
		if (!frappe || !frappe.ui || !frappe.ui.form || typeof frappe.ui.form.on !== "function") {
			return false;
		}
		frappe.ui.form.on("Intelligence Skill", {
			refresh(frm) {
				setupChipEditors(frm);
			},
			validate(frm) {
				validateScopes(frm);
			},
		});
		return true;
	}

	registerSkillForm(global);
	Object.assign(fi, {
		skillForm: {
			chipFields: CHIP_FIELDS,
			readScopeOptions: readScopeOptions,
			validateScopes: validateScopes,
			registerSkillForm: registerSkillForm,
		},
	});
});
