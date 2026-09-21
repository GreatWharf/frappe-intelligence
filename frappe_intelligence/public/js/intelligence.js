/* Intelligence - dependency-free Desk client. No provider credentials or chat data are stored in browser storage. */
(function (global, factory) {
	"use strict";
	const client = factory(global);
	if (typeof module === "object" && module.exports) module.exports = client;
	if (global.frappe) {
		global.frappe.intelligence = client;
		// Resolve install at call time: module scripts attach it after this file.
		const boot = () => client.install();
		if (global.document) {
			if (global.jQuery) global.jQuery(global.document).on("app_ready.intelligence", boot);
			if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", boot, { once: true });
			else global.setTimeout(boot, 0);
		}
	}
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi || (global.fi = {});
	const API = "frappe_intelligence.api.";
	const LOGO = "/assets/frappe_intelligence/images/intelligence.svg";
	const ACTIVE = new Set(["queued", "running", "awaiting_approval"]);
	const KINDS = ["OpenAI", "Anthropic", "Gemini", "OpenRouter", "xAI", "Custom"];
	const EFFORTS = ["Auto", "Low", "Medium", "High", "Max"];
	const APPROVAL_MODES = ["Approve Every Step", "Approve Writes Only", "Automatic"];
	// Single source for the Intelligence settings dialog; the native Desk path maps
	// these onto frappe.ui.Dialog fieldtypes and the mock preview renders the same
	// spec with plain controls.
	const SETTINGS_FIELDS = [
		{ fieldname: "enabled", label: "Enabled", fieldtype: "Check", description: "Turn the assistant on or off for the whole site." },
		{ fieldname: "approval_mode", label: "Approval mode", fieldtype: "Select", options: APPROVAL_MODES, description: "Approve Every Step asks before every tool call. Approve Writes Only auto-runs reads and asks before changes. Automatic runs the reviewed tool set without asking." },
		{ fieldname: "max_steps", label: "Max steps per run", fieldtype: "Int" },
		{ fieldname: "max_run_seconds", label: "Run time limit (seconds)", fieldtype: "Int" },
		{ fieldname: "approval_expiry_minutes", label: "Approval expiry (minutes)", fieldtype: "Int" },
		{ fieldname: "max_upload_mb", label: "Upload size limit (MB)", fieldtype: "Int" },
		{ fieldname: "max_file_chars", label: "File content limit (characters)", fieldtype: "Int" },
		{ fieldname: "daily_run_limit", label: "Daily run limit per user", fieldtype: "Int" },
		{ fieldname: "allowed_reports", label: "Allowed reports", fieldtype: "Small Text", description: "One report name per line. Blank means no reports." },
		{ fieldname: "allowed_custom_hosts", label: "Allowed custom provider hosts", fieldtype: "Small Text", description: "One hostname per line. Required for Custom providers." }
	];
	const LABELS = { queued: "Queued", running: "Working", awaiting_approval: "Needs your approval", completed: "Completed", failed: "Run failed", cancelled: "Cancelled", needs_reconciliation: "Needs review" };
	const PAGE = "intelligence";
	const icons = {
		plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
		chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2V12a9 9 0 0 1 18-.5Z"/>',
		close: '<path d="m6 6 12 12M6 18 18 6"/>', arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
		chevron: '<path d="m9 5 7 7-7 7"/>', down: '<path d="m6 9 6 6 6-6"/>',
		settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
		memory: '<path d="M6 3h12v18l-6-4-6 4Z"/><path d="M9 7h6m-6 4h4"/>',
		lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
		attach: '<path d="m9 12 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l10-10m-4 10 5-5"/>',
		check: '<path d="m5 12 4 4L19 6"/>', archive: '<path d="M4 8h16v13H4Z"/><path d="M3 3h18v5H3Zm6 9h6"/>',
		edit: '<path d="m14 5 5 5M4 20l5-1L20 8a3 3 0 0 0-4-4L5 15Z"/>',
		panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
		share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6m-7.6 6 7.6 3.6"/>',
		link: '<path d="M10 14a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
		file: '<path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h5"/>',
		retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
		stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.3 11.3 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.3-11.3 1.4-1.4"/>',
		grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
		target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
		wrench: '<path d="M14.5 6.5a4.2 4.2 0 0 1 5.6-4L17.5 5l1.5 1.5 2.6-2.6a4.2 4.2 0 0 1-5.7 5.6L7.6 18.7a2 2 0 0 1-2.9-2.9l8.2-8.2a4.2 4.2 0 0 1 1.6-1.1Z"/>',
		menu: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>'
	};
	function icon(name) { return '<svg class="fi-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.chat) + '</svg>'; }
	function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
	function contextFromRoute(route) {
		if (!Array.isArray(route) || !["Form", "List"].includes(route[0]) || typeof route[1] !== "string") return null;
		const context = { doctype: route[1] };
		if (route[0] === "Form" && typeof route[2] === "string" && !route[2].startsWith("new-")) context.name = route[2];
		return context;
	}
	function userError(error) {
		const status = error && (error.status || error.statusCode);
		if (status === 403) return "You do not have permission for this action. Your session may have expired; refresh Desk and try again.";
		if (status === 413) return "This file is too large. Choose a smaller PDF or text file.";
		if (status === 429) return "Too many requests. Wait a moment before trying again.";
		let message = error && error.userMessage;
		if (!message && error && error._server_messages) {
			try { let entry = JSON.parse(error._server_messages)[0]; if (typeof entry === "string") { try { entry = JSON.parse(entry); } catch (_) { /* plain server text */ } } message = typeof entry === "string" ? entry : entry.message; } catch (_) { /* Do not expose a traceback. */ }
		}
		return message ? String(message).replace(/<[^>]*>/g, "").slice(0, 800) : "Could not reach Intelligence. Check your connection and refresh. A submitted action may already have reached the server.";
	}
	function request(method, args) {
		return new Promise((resolve, reject) => {
			const frappe = global.frappe;
			if (!frappe || !frappe.call) { reject({ userMessage: "Intelligence is available inside Frappe Desk." }); return; }
			let done = false;
			const settle = (fn, value) => { if (!done) { done = true; global.clearTimeout(timer); fn(value); } };
			const timer = global.setTimeout(() => settle(reject, { userMessage: "The request timed out. Refresh before retrying; the server may have accepted the action." }), 45000);
			try {
				const pending = frappe.call({ method: method.includes(".") ? method : API + method, args: args || {}, silent: true,
					callback: (response) => response && response.exc ? settle(reject, response) : settle(resolve, response && response.message),
					error: (error) => settle(reject, error && error.responseJSON ? Object.assign({ status: error.status }, error.responseJSON) : error) });
				if (pending && pending.catch) pending.catch((error) => settle(reject, error));
			} catch (error) { settle(reject, error); }
		});
	}
	function button(action, label, glyph, classes, extra) { return '<button type="button" class="btn btn-sm ' + (classes && classes.includes("fi-primary") ? "btn-primary" : "btn-default") + ' fi-btn ' + (classes || "") + '" data-action="' + action + '" ' + (extra || "") + '>' + (glyph ? icon(glyph) : "") + '<span>' + esc(label) + "</span></button>"; }
	function iconButton(action, label, glyph, extra) { return '<button type="button" class="fi-icon-btn" data-action="' + action + '" aria-label="' + esc(label) + '" title="' + esc(label) + '" ' + (extra || "") + '>' + icon(glyph) + "</button>"; }
	function time(value) { if (!value) return ""; const date = new Date(String(value).replace(" ", "T")); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
	function stamp(value) { if (!value) return ""; const date = new Date(String(value).replace(" ", "T")); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
	function parsed(value, fallback) { if (typeof value !== "string") return value || fallback; try { return JSON.parse(value); } catch (_) { return fallback; } }
	function dashed(doctype) { return String(doctype || "").trim().toLowerCase().replace(/[\s_]+/g, "-"); }
	function effortOptions(selected) {
		const current = EFFORTS.includes(selected) ? selected : "Auto";
		return EFFORTS.map((effort) => "<option" + (effort === current ? " selected" : "") + ">" + esc(effort) + "</option>").join("");
	}
	function skillsHTML(data, options) {
		const source = data && typeof data === "object" ? data : {};
		const tools = (Array.isArray(source.tools) ? source.tools : []).filter((tool) => tool && tool.name);
		const scopes = source.scopes && typeof source.scopes === "object" ? source.scopes : {};
		const never = Array.isArray(source.never_allow) ? source.never_allow : [];
		const chips = (list, empty) => {
			const values = Array.isArray(list) ? list : [];
			return values.length ? '<div class="fi-chip-list">' + values.map((item) => '<span class="fi-chip">' + esc(item) + "</span>").join("") + "</div>" : '<p class="fi-section-empty fi-muted">' + esc(empty) + "</p>";
		};
		return '<div class="fi-skills"><h3 class="fi-section-title">Tools</h3>' + (tools.length ? '<div class="fi-skill-list">' + tools.map((tool) => '<div class="fi-skill-row"><div class="fi-skill-head"><code>' + esc(tool.name) + "</code>" + (tool.mutates ? '<span class="fi-badge fi-badge-writes">Writes</span>' : "") + (tool.external ? '<span class="fi-badge">External</span>' : "") + (tool.enabled === false ? '<span class="fi-badge">Off</span>' : "") + (tool.version ? '<span class="fi-skill-version">v' + esc(tool.version) + "</span>" : "") + '</div><p class="fi-skill-desc">' + esc(tool.description || "") + "</p></div>").join("") + "</div>" : '<p class="fi-section-empty fi-muted">No tools are currently enabled.</p>') + learnedSkillsHTML(source.learned_skills, options) + '<h3 class="fi-section-title">Readable doctypes</h3>' + chips(scopes.read, "No readable doctypes are configured.") + '<h3 class="fi-section-title">Writable doctypes</h3>' + chips(scopes.write, "No writable doctypes are configured.") + '<p class="fi-never-note">' + icon("lock") + "<span>" + (never.length ? "Always off-limits, whatever the configuration: " + never.map((item) => esc(item)).join(", ") + "." : "Some record types are always off-limits, whatever the configuration.") + "</span></p></div>";
	}
	function learnedSkillsHTML(skills, options) {
		const list = (Array.isArray(skills) ? skills : []).filter((skill) => skill && skill.name);
		if (!list.length) return "";
		const opts = options && typeof options === "object" ? options : {};
		const enabled = (skill) => skill.enabled === undefined ? true : !!Number(skill.enabled);
		const editable = (skill) => !!(opts.isManager || Number(skill.can_edit) === 1 || skill.can_edit === true || (opts.user && skill.owner && String(skill.owner) === String(opts.user)));
		return '<h3 class="fi-section-title">Learned skills</h3><div class="fi-skill-list">' + list.map((skill) => '<div class="fi-skill-row fi-learned-row"><div class="fi-skill-head"><strong class="fi-skill-title">' + esc(skill.title || skill.name) + "</strong><code>" + esc(skill.name) + '</code><span class="fi-badge fi-badge-origin">' + (skill.origin === "Seeded" ? "Seeded" : "Learned") + "</span>" + (enabled(skill) ? "" : '<span class="fi-badge">Off</span>') + (skill.version ? '<span class="fi-skill-version">v' + esc(skill.version) + "</span>" : "") + '</div><p class="fi-skill-desc">' + esc(skill.description || "") + "</p>" + (editable(skill) ? '<div class="fi-skill-actions"><label class="fi-skill-toggle"><input type="checkbox" data-input="skill-enabled" data-name="' + esc(skill.name) + '"' + (enabled(skill) ? " checked" : "") + "> Enabled</label>" + button("skill-edit", "Edit", "edit", "fi-text-btn", 'data-name="' + esc(skill.name) + '"') + "</div>" : "") + "</div>").join("") + "</div>";
	}
	function lines(value) { return Array.from(new Set(String(value || "").split("\n").map((line) => line.trim()).filter(Boolean))); }
	function scopeState(settings, skills) {
		const doc = settings && typeof settings === "object" ? settings : {};
		const data = skills && typeof skills === "object" ? skills : {};
		const enabled = new Set(lines(doc.enabled_tools));
		const tools = (Array.isArray(data.tools) ? data.tools : []).filter((tool) => tool && tool.name).map((tool) => ({ name: String(tool.name), description: String(tool.description || ""), mutates: !!tool.mutates, enabled: enabled.has(String(tool.name)) }));
		return { tools, read: lines(doc.allowed_read_doctypes), write: lines(doc.allowed_write_doctypes), never_allow: Array.isArray(data.never_allow) ? data.never_allow.map((item) => String(item)) : [] };
	}
	function scopeProblem(state) {
		const read = new Set(state.read), never = new Set(state.never_allow);
		const blocked = state.write.filter((name) => never.has(name));
		if (blocked.length) return blocked.join(", ") + (blocked.length === 1 ? " is" : " are") + " always off-limits and cannot be writable.";
		const missing = state.write.filter((name) => !read.has(name));
		if (missing.length) return "Writable doctypes must also be readable: " + missing.join(", ") + ".";
		return "";
	}
	function scopeHTML(state, options) {
		const readOnly = !!(options && options.readOnly), off = readOnly ? " disabled" : "";
		const rows = (key, title, list) => '<h3 class="fi-section-title">' + esc(title) + '</h3><div class="fi-scope-rows" data-scope-rows="' + key + '">' + (list.length ? list.map((value) => '<div class="fi-scope-row"><code>' + esc(value) + '</code><button type="button" class="fi-icon-btn" data-action="scope-remove" data-list="' + key + '" data-value="' + esc(value) + '" aria-label="Remove ' + esc(value) + '"' + off + ">" + icon("close") + "</button></div>").join("") : '<p class="fi-section-empty fi-muted">None configured.</p>') + "</div>" + (readOnly ? "" : '<div class="fi-scope-add"><input class="form-control" data-input="scope-add-' + key + '" placeholder="DocType name, e.g. Customer" aria-label="Add a doctype to the ' + key + ' list"><button type="button" class="btn btn-sm btn-default fi-btn" data-action="scope-add" data-list="' + key + '">Add</button></div>');
		return '<div class="fi-scope"><p class="fi-dialog-copy">' + (readOnly ? "Only system managers can change scope. Your effective access is shown here." : "Choose the tools and record types Intelligence may use. The server re-validates every save.") + '</p><h3 class="fi-section-title">Enabled tools</h3><div class="fi-scope-tools">' + (state.tools.length ? state.tools.map((tool) => '<label class="fi-scope-tool"><input type="checkbox" data-input="scope-tool" value="' + esc(tool.name) + '"' + (tool.enabled ? " checked" : "") + off + '><span><code>' + esc(tool.name) + "</code>" + (tool.mutates ? ' <span class="fi-badge fi-badge-writes">Writes</span>' : "") + "<small>" + esc(tool.description) + "</small></span></label>").join("") : '<p class="fi-section-empty fi-muted">No tools are available.</p>') + "</div>" + rows("read", "Readable doctypes", state.read) + rows("write", "Writable doctypes", state.write) + '<p class="fi-never-note">' + icon("lock") + "<span>" + (state.never_allow.length ? "Always off-limits: " + state.never_allow.map((item) => esc(item)).join(", ") + ". Writable doctypes must also be readable." : "Writable doctypes must also be readable; some record types are always off-limits.") + "</span></p>" + (readOnly ? "" : "<footer>" + button("scope-save", "Save scope", "check", "fi-primary") + "</footer>") + "</div>";
	}
	function mergeMessages(older, newer) {
		const messages = new Map(); for (const message of older.concat(newer)) messages.set(message.name, message);
		return Array.from(messages.values()).sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
	}
	class App {
		constructor(options) {
			this.api = options && options.api || request; this.doc = options && options.document || global.document;
			this.boot = null; this.conversations = []; this.selected = null; this.snapshot = null; this.drafts = new Map(); this.watched = new Map(); this.pending = new Set(); this.inflight = new Map(); this.history = new Map(); this.expandedTools = new Set();
			this.visible = false; this.archived = false; this.provider = ""; this.context = null; this.loading = false; this.online = true; this.error = ""; this.notice = ""; this.selectVersion = 0; this.listVersion = 0; this.lastList = 0; this.failures = 0; this.messageSignature = ""; this.renaming = false;
			this.poller = new fi.Poller(() => this.poll()); this.root = this.doc.createElement("section"); this.root.className = "fi-app"; this.root.setAttribute("aria-label", "Intelligence workspace");
			this.root.innerHTML = this.shell(); this.bind(); this.render();
		}
		shell() {
			// One column: conversation navigation lives in the native Desk sidebar
			// and the Intelligence Conversation list; this shell is the chat itself.
			return '<div class="fi-main"><header class="fi-header"><div class="fi-header-left">'
				+ '<div class="fi-heading"><button type="button" class="fi-title-btn" data-action="rename-title" title="Rename conversation"><h2 data-slot="title">New conversation</h2></button><span data-slot="subtitle" class="fi-subtitle"></span></div></div>'
				+ '<div class="fi-header-actions">'
				+ '<span data-slot="shared-chip"></span>'
				+ iconButton("share", "Share conversation", "share")
				+ iconButton("archive", "Archive conversation", "archive")
				+ '<div class="fi-menu-wrap">'
				+ iconButton("menu", "Conversation and Intelligence settings", "menu", 'aria-haspopup="menu" aria-expanded="false"')
				+ '<div class="fi-menu" data-slot="menu" role="menu" hidden>'
				+ '<button type="button" role="menuitem" data-action="conversations-list">' + icon("chat") + "<span>All conversations</span></button>"
				+ '<div class="fi-menu-sep" role="separator"></div>'
				+ '<button type="button" role="menuitem" data-action="settings">' + icon("settings") + "<span>Providers &amp; models</span></button>"
				+ '<button type="button" role="menuitem" data-action="memory">' + icon("memory") + "<span>Memory</span></button>"
				+ '<button type="button" role="menuitem" data-action="skills">' + icon("grid") + "<span>Skills</span></button>"
				+ '<button type="button" role="menuitem" data-action="scope">' + icon("target") + "<span>Scope</span></button>"
				+ '<button type="button" role="menuitem" data-action="app-settings">' + icon("settings") + "<span>Intelligence settings</span></button>"
				+ "</div></div>"
				+ button("new", "New", "plus", "fi-primary")
				+ iconButton("expand", "Open full workspace", "expand") + iconButton("close", "Close Intelligence", "close")
				+ '</div></header>'
				+ '<div class="fi-banner" data-slot="banner" role="status" hidden></div>'
				+ '<div class="fi-thread-wrap"><div class="fi-thread" data-slot="thread" tabindex="0" aria-label="Messages"><div class="fi-thread-inner" data-slot="messages"></div></div>'
				+ '<button type="button" class="fi-scroll-bottom" data-action="scroll-bottom" hidden aria-label="Scroll to the latest messages">' + icon("down") + "<span>Latest</span></button></div>"
				+ '<div class="fi-bottom"><div class="fi-run" data-slot="run" aria-live="polite" hidden></div><div class="fi-context-list" data-slot="context"></div>'
				+ '<div class="fi-readonly" data-slot="readonly" hidden></div>'
				+ '<form class="fi-composer" aria-label="Message composer"><textarea data-input="message" rows="2" maxlength="100000" aria-label="Message Intelligence" placeholder="Ask a question, explore your data, or get something done…"></textarea><div class="fi-attachments" data-slot="attachments"></div><div class="fi-composer-toolbar"><div class="fi-composer-tools">' + iconButton("attach", "Attach a private PDF or text file", "attach") + '<label class="fi-provider-label"><span class="fi-provider-dot" aria-hidden="true"></span><select data-input="provider" aria-label="Provider and model"></select>' + icon("down") + '</label></div><button type="submit" class="fi-send" aria-label="Send message" title="Send message">' + icon("arrow") + '</button></div></form>'
				+ '<div class="fi-composer-caption"><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span></div></div></div>';
		}
		$(selector) { return this.root.querySelector(selector); }
		slot(name) { return this.$('[data-slot="' + name + '"]'); }
		draft() { const key = this.selected || "new"; if (!this.drafts.has(key)) this.drafts.set(key, { text: "", attachments: [] }); return this.drafts.get(key); }
		isActive() { return !!(this.snapshot && this.snapshot.run && ACTIVE.has(this.snapshot.run.state)); }
		readOnly() { return !!(this.snapshot && this.snapshot.can_post === false) || !!(this.snapshot && Number(this.snapshot.conversation.archived)); }
		busy(key, work) {
			if (this.pending.has(key)) return Promise.resolve();
			this.pending.add(key); this.renderControls();
			return Promise.resolve().then(work).catch((error) => { this.error = userError(error); this.renderBanner(); }).finally(() => { this.pending.delete(key); this.renderControls(); });
		}
		bind() {
			this.root.addEventListener("click", (event) => {
				const menu = this.slot("menu");
				if (menu && !menu.hidden && !event.target.closest(".fi-menu-wrap")) { menu.hidden = true; this.$('[data-action="menu"]').setAttribute("aria-expanded", "false"); }
				const target = event.target.closest("[data-action]"); if (target && this.root.contains(target) && !target.disabled) this.action(target.dataset.action, target);
			});
			this.root.addEventListener("input", (event) => {
				if (event.target.dataset.input === "message") { this.draft().text = event.target.value; this.resizeComposer(); this.renderControls(); }
			});
			this.root.addEventListener("change", (event) => { if (event.target.dataset.input === "provider") this.provider = event.target.value; });
			this.slot("thread").addEventListener("scroll", () => this.syncScrollButton());
			this.$("form").addEventListener("submit", (event) => { event.preventDefault(); this.send(); });
			this.$("textarea").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); this.send(); } });
		}
		async init() {
			if (this.initializing) return this.initializing;
			this.initializing = (async () => {
				try { this.loading = true; this.render(); this.boot = await this.api("bootstrap"); if (!this.boot || !this.boot.enabled) { this.error = "Intelligence is disabled on this site. Contact your system manager."; return; }
					this.provider = this.provider || this.boot.defaults && this.boot.defaults.provider || this.boot.providers && this.boot.providers[0] && this.boot.providers[0].name || "";
					await this.refreshList(); this.error = "";
				} catch (error) { this.error = userError(error); } finally { this.loading = false; this.render(); this.poller.start(0); this.initializing = null; this.refitViewport(); }
			})(); return this.initializing;
		}
		show(host, mode) {
			this.visible = true; this.mode = mode || "page"; this.root.classList.toggle("fi-drawer-app", this.mode === "drawer"); host.appendChild(this.root);
			this.render();
			if (!this.boot) this.init(); else this.poller.start(0);
			this.fitViewport(); this.refitViewport();
			if (!this.viewportBound && global.addEventListener) { this.viewportBound = true; global.addEventListener("resize", () => this.fitViewport()); }
		}
		hide() { this.visible = false; this.closeMenu(); this.poller.stop(); if (this.watched.size) this.poller.start(1000); }
		// Desk page bodies are not always height-constrained, and whether the
		// document itself scrolls depends on Desk chrome; measure the app instead
		// and pin it to the remaining viewport whenever it outgrows it, so the
		// composer stays visible and only the thread and conversation list scroll.
		fitViewport() {
			if (!this.root.isConnected || typeof this.root.getBoundingClientRect !== "function") return;
			this.root.style.height = "";
			if (this.mode !== "page") return;
			const viewport = Number(global.innerHeight) || 0;
			if (!viewport) return;
			const rect = this.root.getBoundingClientRect();
			const available = Math.floor(viewport - rect.top - 8);
			if (available >= 320 && rect.height > available + 4) this.root.style.height = available + "px";
		}
		// On a hard reload Desk chrome is still laying out when show() measures, so
		// the pin never applies and the whole document grows instead of the thread
		// scrolling. Re-measure on the next frame and after each async load settles.
		refitViewport() { if (global.requestAnimationFrame) global.requestAnimationFrame(() => this.fitViewport()); }
		closeMenu() { const menu = this.slot("menu"); if (menu) menu.hidden = true; const trigger = this.$('[data-action="menu"]'); if (trigger) trigger.setAttribute("aria-expanded", "false"); }
		async refreshList() {
			const version = ++this.listVersion;
			const rows = await this.api("list_conversations", { archived: this.archived ? 1 : 0 });
			if (version !== this.listVersion) return;
			this.conversations = Array.isArray(rows) ? rows : [];
			this.lastList = Date.now();
			for (const row of this.conversations) if (row.active_run && !this.watched.has(row.name)) this.watched.set(row.name, { name: typeof row.active_run === "object" ? row.active_run.name : row.active_run, state: "running" });
		}
		async fetchConversation(name) {
			if (this.inflight.has(name)) return this.inflight.get(name);
			const promise = this.api("get_conversation", { conversation: name }).finally(() => this.inflight.delete(name)); this.inflight.set(name, promise); return promise;
		}
		navigate(name) {
			const frappe = global.frappe;
			if (!frappe || !frappe.set_route || !frappe.get_route || this.mode !== "page") return;
			const route = frappe.get_route();
			const current = route && route[0] === PAGE ? route[1] || "" : null;
			if (current === null || current === (name || "")) return;
			if (name) frappe.set_route(PAGE, name); else frappe.set_route(PAGE);
		}
		async select(name) {
			if (this.pending.has("send") || this.pending.has("upload")) { this.navigate(this.selected); return; }
			const version = ++this.selectVersion; this.selected = name; this.snapshot = null; this.error = ""; this.notice = ""; this.messageSignature = ""; this.loadingConversation = true; this.renaming = false; this.expandedTools.clear(); this.navigate(name); this.render(); this.syncDraft();
			try { const data = await this.fetchConversation(name); if (version !== this.selectVersion) return; this.accept(name, data); }
			catch (error) {
				// A bogus or revoked conversation name must not linger in the URL or the
				// poll loop: fall back to the home view instead of retrying forever.
				if (version === this.selectVersion) { this.selected = null; this.snapshot = null; this.navigate(null); this.watched.delete(name); this.error = userError(error); }
			}
			finally { if (version === this.selectVersion) { this.loadingConversation = false; this.render(); this.poller.start(0); this.refitViewport(); } }
		}
		newConversation() {
			if (this.pending.has("send") || this.pending.has("upload")) { this.navigate(this.selected); return; }
			this.selectVersion++; this.selected = null; this.snapshot = null; this.loadingConversation = false; this.error = ""; this.notice = ""; this.renaming = false; this.expandedTools.clear(); this.navigate(null); this.render(); this.syncDraft(); this.$("textarea").focus();
		}
		accept(name, data) {
			if (!data || !data.conversation) return;
			const previous = this.watched.get(name), run = data.run;
			if (run && ACTIVE.has(run.state)) this.watched.set(name, run); else this.watched.delete(name);
			if (previous && run && !ACTIVE.has(run.state)) {
				this.lastList = 0;
				if (!this.visible || name !== this.selected) { this.notice = (data.conversation.title || "Conversation") + " · " + (LABELS[run.state] || run.state); if (this.onBackground) this.onBackground(name, this.notice); }
			}
			if (name === this.selected) {
				const history = this.history.get(name);
				if (history) data = Object.assign({}, data, { messages: mergeMessages(history.messages, data.messages || []), has_earlier_messages: history.hasEarlier });
				this.snapshot = data; this.provider = data.conversation.provider || this.provider; this.render();
			}
		}
		async poll() {
			if (!this.boot || !this.boot.enabled || (!this.visible && !this.watched.size)) return null;
			if (this.doc.hidden || (global.navigator && global.navigator.onLine === false)) { this.online = false; this.renderBanner(); return 10000; }
			try {
				const names = new Set(this.watched.keys()); if (this.visible && this.selected) names.add(this.selected);
				for (const name of names) { const data = await this.fetchConversation(name); this.accept(name, data); }
				if (this.visible && Date.now() - this.lastList > 20000) await this.refreshList();
				this.online = true; this.failures = 0; this.renderBanner();
			} catch (_) { this.online = false; this.failures++; this.renderBanner(); }
			return this.visible || this.watched.size ? Math.min(30000, this.failures ? 3000 * Math.pow(2, Math.min(this.failures, 3)) : this.watched.size ? 3000 : 15000) : null;
		}
		loadEarlier() {
			if (!this.snapshot || !this.snapshot.has_earlier_messages || !this.snapshot.messages.length) return Promise.resolve();
			const name = this.selected, version = this.selectVersion, cursor = this.snapshot.messages[0].sequence;
			return this.busy("earlier", async () => {
				const page = await this.api("get_conversation", { conversation: name, before_sequence: cursor });
				if (name !== this.selected || version !== this.selectVersion || !this.snapshot) return;
				const thread = this.slot("thread"), height = thread.scrollHeight, top = thread.scrollTop;
				this.snapshot.messages = mergeMessages(page.messages || [], this.snapshot.messages);
				this.snapshot.has_earlier_messages = !!page.has_earlier_messages && !!(page.messages && page.messages.length);
				this.history.set(name, { messages: this.snapshot.messages, hasEarlier: this.snapshot.has_earlier_messages });
				this.renderMessages(); thread.scrollTop = top + thread.scrollHeight - height;
				const more = this.$('[data-action="earlier"]'); if (more) more.focus(); else thread.focus();
			});
		}
		refresh() { this.error = ""; if (!this.boot) return this.init(); this.poller.start(0); this.renderBanner(); }
		render() { this.renderHeader(); this.renderMessages(); this.renderRun(); this.renderContext(); this.renderAttachments(); this.renderProviders(); this.renderControls(); this.renderBanner(); }
		providerRow() {
			const providers = this.boot && this.boot.providers || [];
			return providers.find((provider) => provider.name === this.provider) || null;
		}
		renderHeader() {
			const title = this.snapshot && this.snapshot.conversation.title || (this.selected ? "Conversation" : "New conversation");
			if (!this.renaming) this.slot("title").textContent = title;
			const row = this.providerRow();
			const conversationModel = this.snapshot && this.snapshot.conversation.model ? String(this.snapshot.conversation.model) : "";
			const conversationEffort = this.snapshot && EFFORTS.includes(this.snapshot.conversation.effort) ? this.snapshot.conversation.effort : "";
			const providerEffort = row && EFFORTS.includes(row.thinking_effort) ? row.thinking_effort : "Auto";
			const effort = conversationEffort && conversationEffort !== "Auto" ? conversationEffort : providerEffort;
			let subtitle;
			if (this.snapshot && Number(this.snapshot.conversation.archived)) subtitle = "Archived · read only";
			else if (this.snapshot && this.snapshot.can_post === false) subtitle = "Shared by " + (this.snapshot.conversation.owner || "another user") + " · read only";
			else if (row) subtitle = row.title + " · " + (conversationModel || row.model) + " · effort " + effort;
			else subtitle = "Private · only you";
			this.slot("subtitle").textContent = subtitle;
			const shared = !!(this.snapshot && Number(this.snapshot.conversation.shared));
			const chip = this.slot("shared-chip");
			chip.innerHTML = shared ? '<span class="fi-shared-chip">' + icon("share") + "<span>Shared</span></span>" : "";
			const selected = !!this.selected;
			for (const action of ["share", "archive"]) this.$('[data-action="' + action + '"]').hidden = !selected;
			this.$('[data-action="rename-title"]').hidden = !selected || !!(this.snapshot && this.snapshot.can_post === false);
			this.$('[data-action="share"]').hidden = !selected || !this.snapshot || this.snapshot.can_post === false;
			this.$('[data-action="expand"]').hidden = this.mode !== "drawer"; this.$('[data-action="close"]').hidden = this.mode !== "drawer";
			const archive = this.$('[data-action="archive"]'); const archived = !!(this.snapshot && Number(this.snapshot.conversation.archived));
			archive.setAttribute("aria-label", archived ? "Restore conversation" : "Archive conversation"); archive.title = archived ? "Restore conversation" : "Archive conversation";
			const share = this.$('[data-action="share"]'); share.setAttribute("aria-label", shared ? "Manage conversation sharing" : "Share conversation"); share.title = share.getAttribute("aria-label");
		}
		renderBanner() {
			const banner = this.slot("banner"); const message = this.error || (!this.online ? "Connection interrupted. Reconnecting automatically; your run continues on the server." : this.notice);
			const signature = JSON.stringify([message, !!this.error]); if (signature === this.bannerSignature) return; this.bannerSignature = signature;
			banner.hidden = !message; banner.classList.toggle("is-error", !!this.error); banner.setAttribute("role", this.error ? "alert" : "status");
			banner.innerHTML = message ? icon(this.error ? "info" : "retry") + "<span>" + esc(message) + "</span>" + button("refresh", "Refresh", null, "fi-text-btn") + iconButton("dismiss", "Dismiss notification", "close") : "";
		}
		renderRun() {
			const run = this.snapshot && this.snapshot.run, slot = this.slot("run");
			const signature = JSON.stringify([run, this.pending.has("cancel")]); if (signature === this.runSignature) return; this.runSignature = signature;
			// A plain completed run needs no banner: the answer in the thread is the outcome.
			const quiet = run && run.state === "completed" && !run.cancel_requested && !run.error;
			slot.hidden = !run || quiet;
			if (!run || quiet) { slot.innerHTML = ""; return; }
			const active = ACTIVE.has(run.state), warning = ["failed", "needs_reconciliation"].includes(run.state);
			slot.classList.toggle("is-warning", warning);
			slot.innerHTML = '<span class="' + (active && run.state !== "awaiting_approval" ? "fi-spinner" : "fi-run-icon") + '">' + (active && run.state !== "awaiting_approval" ? "" : icon(warning ? "info" : run.state === "awaiting_approval" ? "lock" : "check")) + '</span><div class="fi-run-copy"><strong>' + esc(LABELS[run.state] || run.state) + "</strong><span>" + esc(run.error || (run.cancel_requested ? "Cancellation requested. An action already in progress may finish." : run.state === "awaiting_approval" ? "You can leave and return. This request is waiting for your decision." : active ? "You can leave this page. Your run is saved and continues in the background." : run.state === "cancelled" ? "Any previously completed actions are not reversed." : run.state === "needs_reconciliation" ? "Check the affected records before trying again." : "This run is saved with your conversation.")) + "</span></div>" + (active && !this.readOnly() ? button("cancel", run.cancel_requested ? "Stopping…" : "Stop", "stop", "fi-text-btn", run.cancel_requested || this.pending.has("cancel") ? "disabled" : "") : "");
		}
		renderContext() {
			const context = this.context;
			const signature = JSON.stringify(context); if (signature === this.contextSignature) return; this.contextSignature = signature;
			this.slot("context").innerHTML = context ? '<span class="fi-context-caption">Context for your next message</span><span class="fi-context-chip">' + icon("file") + "<span>" + esc(context.doctype) + (context.name ? '<span class="fi-context-divider">/</span>' + esc(context.name) : "") + "</span>" + iconButton("remove-context", "Remove page context", "close") + "</span>" : "";
		}
		startRename() {
			if (!this.snapshot || this.renaming || this.snapshot.can_post === false) return;
			this.renaming = true;
			const titleSlot = this.slot("title"), current = this.snapshot.conversation.title || "";
			const input = this.doc.createElement("input");
			input.className = "form-control fi-title-input"; input.value = current; input.maxLength = 140; input.setAttribute("aria-label", "Rename conversation");
			const h2 = titleSlot; h2.replaceWith ? h2.replaceWith(input) : titleSlot.parentNode.replaceChild(input, h2);
			input.focus(); input.select();
			let done = false;
			const commit = async (save) => {
				if (done) return; done = true; this.renaming = false;
				const title = input.value.trim(); const name = this.selected;
				const restore = this.doc.createElement("h2"); restore.setAttribute("data-slot", "title"); restore.textContent = title || current;
				input.replaceWith ? input.replaceWith(restore) : input.parentNode.replaceChild(restore, input);
				if (save && title && title !== current && name === this.selected) {
					try { await this.api("rename_conversation", { conversation: name, title }); if (this.selected === name && this.snapshot) this.snapshot.conversation.title = title; await this.refreshList(); }
					catch (error) { this.error = userError(error); }
				}
				this.renderHeader();
			};
			input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commit(true); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); commit(false); } });
			input.addEventListener("blur", () => commit(true));
		}
		action(action, target) {
			if (action === "select") return this.select(target.dataset.name);
			if (action === "new") return this.newConversation();
			if (action === "menu") { const menu = this.slot("menu"); menu.hidden = !menu.hidden; target.setAttribute("aria-expanded", String(!menu.hidden)); return; }
			if (action === "conversations-list") { this.closeMenu(); if (global.frappe && global.frappe.set_route) global.frappe.set_route("List", "Intelligence Conversation"); return; }
			if (action === "starter") { this.draft().text = target.dataset.prompt; this.syncDraft(); this.$("textarea").focus(); return; }
			if (action === "remove-context") { this.context = null; this.renderContext(); return; }
			if (action === "remove-file") { this.draft().attachments = this.draft().attachments.filter((file) => file.name !== target.dataset.name); this.renderAttachments(); this.messageSignature = ""; this.renderMessages(); return; }
			if (action === "dismiss") { this.error = ""; this.notice = ""; this.renderBanner(); return; }
			if (action === "refresh") return this.refresh();
			if (action === "earlier") return this.loadEarlier();
			if (action === "close") return this.onClose && this.onClose();
			if (action === "expand") return this.onExpand && this.onExpand();
			if (action === "settings") { this.closeMenu(); return this.providerDialog(); }
			if (action === "memory") { this.closeMenu(); return this.memoryDialog(); }
			if (action === "skills") { this.closeMenu(); return this.skillsDialog(); }
			if (action === "scope") { this.closeMenu(); return this.scopeDialog(); }
			if (action === "app-settings") { this.closeMenu(); return this.settingsDialog(); }
			if (action === "toggle-tools") {
				const card = target.closest(".fi-tool-group"), body = card && card.querySelector(".fi-tool-group-body");
				if (!body) return;
				const open = body.hidden; body.hidden = !open; card.classList.toggle("is-open", open); target.setAttribute("aria-expanded", String(open));
				if (open) this.expandedTools.add(target.dataset.key); else this.expandedTools.delete(target.dataset.key);
				this.syncScrollButton();
				return;
			}
			if (action === "scroll-bottom") {
				const thread = this.slot("thread");
				const reduce = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
				if (thread.scrollTo) thread.scrollTo({ top: thread.scrollHeight, behavior: reduce ? "auto" : "smooth" });
				else thread.scrollTop = thread.scrollHeight;
				return;
			}
			if (action === "rename-title") return this.startRename();
			if (action === "archive") return this.archiveDialog();
			if (action === "share") return this.shareDialog();
			if (action === "attach") return this.chooseFile();
			if (action === "copy-code") { const text = target.closest(".fi-code").querySelector("code").textContent; if (!global.navigator || !global.navigator.clipboard) { this.error = "Clipboard access is unavailable. Select and copy the code directly."; this.renderBanner(); return; } return global.navigator.clipboard.writeText(text).then(() => { target.textContent = "Copied"; global.setTimeout(() => { target.textContent = "Copy"; }, 1800); }).catch(() => { this.error = "Could not copy. Select and copy the code directly."; this.renderBanner(); }); }
			if (action === "cancel") return this.busy("cancel", async () => { const name = this.selected; await this.api("cancel", { run: this.snapshot.run.name }); this.accept(name, await this.fetchConversation(name)); this.poller.start(0); });
			if (["approve", "deny", "always"].includes(action)) { const name = this.selected; return this.busy("approval:" + target.dataset.name, async () => { await this.api("approve", { approval: target.dataset.name, decision: action }); if (action === "always") { this.notice = "Approved. This action will not ask again."; this.renderBanner(); } this.accept(name, await this.fetchConversation(name)); this.poller.start(0); }); }
			// Modules may register additional actions as App.prototype["action_<name>"].
			const handler = this["action_" + action];
			if (typeof handler === "function") return handler.call(this, target);
		}
		// Every Desk-host dialog is a declarative frappe.ui.Dialog via nativeForm;
		// dialog() only ever runs on hosts without frappe.ui (the mock preview),
		// so it always builds the fallback overlay.
		dialog(title, body, options) {
			if (this.modal) this.modal.close();
			return this.fallbackDialog(title, body, options);
		}
		fallbackDialog(title, body, options) {
			const previous = this.doc.activeElement, overlay = this.doc.createElement("div"); overlay.className = "fi-modal-overlay";
			overlay.innerHTML = '<section class="fi-modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><header><div><h2>' + esc(title) + "</h2></div>" + iconButton("modal-close", "Close dialog", "close") + '</header><div class="fi-modal-body">' + body + '</div><div class="fi-modal-error" role="alert" hidden></div></section>';
			this.doc.body.appendChild(overlay);
			const modal = { element: overlay, busy: false, closed: false, close: () => { if (modal.busy) return; modal.closed = true; overlay.remove(); if (this.modal === modal) this.modal = null; if (previous && previous.isConnected) previous.focus(); }, error: (error) => { const node = overlay.querySelector(".fi-modal-error"); node.hidden = false; node.textContent = userError(error); }, run: async (work) => { if (modal.busy || modal.closed) return; modal.busy = true; const focused = this.doc.activeElement, controls = Array.from(overlay.querySelectorAll("button, input, select, textarea")); const disabled = controls.map((node) => node.disabled); controls.forEach((node) => { node.disabled = true; }); overlay.querySelector(".fi-modal-error").hidden = true; try { await work(); } catch (error) { modal.error(error); } finally { modal.busy = false; controls.forEach((node, index) => { node.disabled = disabled[index]; }); if (!modal.closed && !overlay.contains(this.doc.activeElement)) { const next = focused && focused.isConnected && !focused.disabled ? focused : overlay.querySelector("input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])"); if (next) next.focus(); } } } };
			this.modal = modal;
			overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest('[data-action="modal-close"]')) modal.close(); });
			overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); modal.close(); } if (event.key === "Tab") trapFocus(event, overlay); });
			global.setTimeout(() => { if (!modal.closed) { const first = overlay.querySelector(options && options.focus || "input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])"); if (first) first.focus(); } }, 0);
			return modal;
		}
		// Declarative frappe.ui.Dialog form: every input is a native Frappe control
		// with native dropdown behavior. Returns the same modal interface the
		// fallback overlay provides so callers share busy/error handling.
		nativeForm(frappe, config) {
			if (this.modal) this.modal.close();
			const previous = this.doc.activeElement;
			const options = { title: config.title, size: config.size || "large", fields: config.fields };
			const modal = {
				instance: null, element: null, busy: false, closed: false,
				close: () => {
					if (modal.busy) return; modal.closed = true;
					try { modal.instance && modal.instance.hide(); } catch (_) { /* already hidden */ }
					if (this.modal === modal) this.modal = null;
					if (previous && previous.isConnected) previous.focus();
				},
				error: (error) => {
					const host = modal.bodyHost() || modal.element;
					if (!host) return;
					let node = host.querySelector(".fi-modal-error");
					if (!node) { node = this.doc.createElement("div"); node.className = "fi-modal-error"; node.setAttribute("role", "alert"); host.appendChild(node); }
					node.hidden = false; node.textContent = userError(error);
				},
				clearError: () => { const host = modal.bodyHost(); const node = host && host.querySelector(".fi-modal-error"); if (node) node.hidden = true; },
				bodyHost: () => modal.instance && (modal.instance.$body && modal.instance.$body[0] || modal.instance.body) || null,
				values: () => modal.instance && modal.instance.get_values ? modal.instance.get_values(true) || {} : {},
				set: (fieldname, value) => modal.instance && modal.instance.set_value ? modal.instance.set_value(fieldname, value) : Promise.resolve(),
				setReadOnly: (readOnly) => {
					if (modal.instance && modal.instance.set_df_property) for (const field of config.fields || []) if (field.fieldname && !["HTML", "Button", "Section Break", "Column Break"].includes(field.fieldtype)) modal.instance.set_df_property(field.fieldname, "read_only", readOnly ? 1 : 0);
				},
				run: async (work) => {
					if (modal.busy || modal.closed) return;
					modal.busy = true; modal.clearError();
					const root = modal.element;
					const controls = root ? Array.from(root.querySelectorAll("button, input, select, textarea")) : [];
					const disabled = controls.map((node) => node.disabled); controls.forEach((node) => { node.disabled = true; });
					try { await work(); } catch (error) { modal.error(error); }
					finally { modal.busy = false; controls.forEach((node, index) => { node.disabled = disabled[index]; }); }
				}
			};
			if (config.primary_action_label && config.primary_action) {
				options.primary_action_label = config.primary_action_label;
				options.primary_action = (values) => modal.run(() => config.primary_action(values || modal.values(), modal));
			}
			if (config.secondary_action_label && config.secondary_action) {
				options.secondary_action_label = config.secondary_action_label;
				options.secondary_action = () => { if (!modal.busy) config.secondary_action(modal); };
			}
			const instance = new frappe.ui.Dialog(options);
			modal.instance = instance;
			modal.element = instance.$wrapper && instance.$wrapper[0] || instance.wrapper || modal.bodyHost();
			this.modal = modal;
			try { instance.show(); } catch (_) { /* test hosts */ }
			return modal;
		}
		archiveDialog() {
			if (!this.snapshot) return; const name = this.selected, restore = !!Number(this.snapshot.conversation.archived);
			const copy = restore ? "Move this conversation back to your active list." : "Your messages and approvals will remain saved. Archiving does not cancel a running task.";
			const commit = async (modal) => { await this.api("archive_conversation", { conversation: name, archived: restore ? 0 : 1 }); this.accept(name, await this.fetchConversation(name)); await this.refreshList(); modal.busy = false; modal.close(); };
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) {
				this.nativeForm(frappe, { title: restore ? "Restore this conversation?" : "Archive this conversation?", size: "small", fields: [{ fieldtype: "HTML", fieldname: "copy", options: '<p class="fi-dialog-copy">' + copy + "</p>" }], primary_action_label: restore ? "Restore conversation" : "Archive conversation", primary_action: (values, modal) => commit(modal) });
				return;
			}
			const modal = this.dialog(restore ? "Restore this conversation?" : "Archive this conversation?", '<p class="fi-dialog-copy">' + copy + "</p><footer>" + button("modal-close", "Keep it here") + button("confirm-archive", restore ? "Restore conversation" : "Archive conversation", "archive", "fi-primary") + "</footer>");
			modal.element.querySelector('[data-action="confirm-archive"]').addEventListener("click", () => modal.run(async () => commit(modal)));
		}
		shareDialog() {
			if (!this.snapshot) return;
			const name = this.selected;
			const copy = "People you share with get a read only view of this conversation, including files and tool actions. Only you can post or approve.";
			let shares = [];
			const listHTML = () => shares.length
				? '<ul class="fi-share-list">' + shares.map((row) => '<li class="fi-share-row"><span class="fi-share-user"><strong>' + esc(row.full_name || row.user) + "</strong><span>" + esc(row.user) + "</span></span>" + button("unshare-user", "Stop sharing with " + (row.full_name || row.user), "close", "fi-text-btn", 'data-user="' + esc(row.user) + '"') + "</li>").join("") + "</ul>"
				: '<div class="fi-share-empty">Not shared with anyone yet.</div>';
			const applyUpdate = (result) => {
				if (result && result.conversation && this.snapshot && this.selected === name) { Object.assign(this.snapshot.conversation, result.conversation); this.renderHeader(); }
				if (result && Array.isArray(result.shares)) shares = result.shares;
			};
			const loadShares = async () => { const rows = await this.api("conversation_share_users", { conversation: name }); if (Array.isArray(rows)) shares = rows; };
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) {
				const modal = this.nativeForm(frappe, {
					title: "Share conversation",
					size: "small",
					fields: [
						{ fieldtype: "HTML", fieldname: "copy", options: '<p class="fi-dialog-copy">' + copy + "</p>" },
						{ fieldtype: "HTML", fieldname: "shares", options: '<div data-shares-host><div class="fi-share-empty">Loading…</div></div>' },
						{ fieldname: "share_with", label: "Share with", fieldtype: "Link", options: "User", description: "They find the conversation in their own list and global search." }
					],
					primary_action_label: "Share",
					primary_action: async (values, m) => {
						const user = String((values && values.share_with) || "").trim();
						if (!user) { m.error({ userMessage: "Choose a user to share with." }); return; }
						applyUpdate(await this.api("share_conversation", { conversation: name, user }));
						paint();
						await m.set("share_with", "");
						if (frappe.show_alert) frappe.show_alert({ message: "Shared with " + user + ".", indicator: "green" });
					}
				});
				const paint = () => { const host = modal.bodyHost() && modal.bodyHost().querySelector("[data-shares-host]"); if (host) host.innerHTML = listHTML(); };
				if (modal.element) modal.element.addEventListener("click", (event) => {
					const target = event.target.closest && event.target.closest('[data-action="unshare-user"]');
					if (!target || modal.busy) return;
					modal.run(async () => { applyUpdate(await this.api("unshare_conversation", { conversation: name, user: target.dataset.user })); paint(); });
				});
				modal.run(async () => { await loadShares(); paint(); });
				return;
			}
			const modal = this.dialog("Share conversation", '<p class="fi-dialog-copy">' + copy + '</p><div data-shares-host><div class="fi-share-empty">Loading…</div></div><label class="fi-field control-label">Share with<input class="form-control" data-share-with placeholder="colleague@example.com" autocomplete="off" maxlength="140"></label><footer>' + button("modal-close", "Done") + button("confirm-share", "Share", "share", "fi-primary") + "</footer>");
			const paint = () => { const host = modal.element.querySelector("[data-shares-host]"); if (host) host.innerHTML = listHTML(); };
			modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-action]"); if (!target || modal.busy) return;
				if (target.dataset.action === "unshare-user") { modal.run(async () => { applyUpdate(await this.api("unshare_conversation", { conversation: name, user: target.dataset.user })); paint(); }); return; }
				if (target.dataset.action !== "confirm-share") return;
				const input = modal.element.querySelector("[data-share-with]"), user = String(input.value || "").trim();
				if (!user) { input.focus(); return; }
				modal.run(async () => { applyUpdate(await this.api("share_conversation", { conversation: name, user })); input.value = ""; paint(); });
			});
			modal.run(async () => { await loadShares(); paint(); });
		}
		providerDialog() {
			if (!this.boot) return;
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) return this.providerDialogNative(frappe);
			return this.providerDialogFallback();
		}
		providerDialogFallback() {
			if (!this.boot) return;
			const providers = this.boot.managed_providers || this.boot.providers || [];
			const modal = this.dialog("Providers & models", '<p class="fi-dialog-copy">Bring your own provider. Credentials stay on the server and are never shown here.</p><div class="fi-provider-settings"><nav class="fi-provider-list" aria-label="Configured providers">' + providers.map((provider) => '<button type="button" data-provider="' + esc(provider.name) + '"><strong>' + esc(provider.title) + "</strong><span>" + esc(provider.kind + " · " + provider.model) + "</span></button>").join("") + '<button type="button" data-provider="">' + icon("plus") + " Add provider</button></nav><form class=\"fi-provider-form\"><h3 data-provider-heading>Add a provider</h3><input type=\"hidden\" name=\"name\"><label class=\"fi-field control-label\">Name<input class=\"form-control\" name=\"title\" required maxlength=\"140\" placeholder=\"My work provider\" autocomplete=\"off\"></label><div class=\"fi-field-row fi-field-row-3\"><label class=\"fi-field control-label\">Provider<select class=\"form-control\" name=\"kind\">" + KINDS.map((kind) => "<option>" + esc(kind) + "</option>").join("") + '</select></label><label class="fi-field control-label">Model ID<input class="form-control" name="model" required maxlength="140" placeholder="Enter your provider\'s model ID" autocomplete="off"><button type="button" class="fi-btn fi-text-btn fi-fetch-models" data-action="fetch-models">Fetch models</button></label><label class="fi-field control-label">Thinking effort<select class="form-control" name="thinking_effort" aria-label="Thinking effort">' + effortOptions() + '</select></label></div><label class="fi-field control-label">API key<input class="form-control" name="api_key" type="password" autocomplete="new-password" placeholder="Enter API key"><span>Stored keys are never shown; leave blank to keep the current key.</span></label><label class="fi-field" data-base-url hidden>Custom endpoint URL<input class="form-control" name="base_url" type="url" placeholder="https://api.example.com/v1" autocomplete="off"><span>HTTPS only. The hostname must be allowlisted by your administrator.</span></label><div class="fi-checkbox-row"><label><input type="checkbox" name="enabled" checked> Enabled</label>' + (this.boot.is_manager ? '<label><input type="checkbox" name="is_shared"> Shared with this site</label>' : "") + '</div><label class="fi-field" data-allowed-roles hidden>Allowed roles<textarea class="form-control" name="allowed_roles" rows="2" placeholder="One Frappe role per line"></textarea><span>For shared providers. Leave blank to allow all authorized Intelligence users.</span></label><div class="fi-field-row"><label class="fi-field control-label">Output token limit<input class="form-control" name="max_tokens" type="number" min="128" max="32768" value="4096" required></label><label class="fi-field control-label">Timeout (seconds)<input class="form-control" name="timeout" type="number" min="5" max="120" value="60" required></label></div><label class="fi-field control-label">Model catalog<textarea class="form-control" name="models" rows="3" placeholder="One model ID per line. Leave blank to allow any model."></textarea><span>Advanced: the allowed catalog for this provider. If set, the model must be in this list.</span></label><p class="fi-field-help" data-provider-note>Saving stores this configuration; it does not test a paid provider request.</p><footer><button type="button" class="fi-btn fi-danger" data-delete-provider hidden>Delete provider</button><button type="submit" class="btn btn-primary btn-sm fi-btn fi-primary">Save provider</button></footer></form></div>');
			const form = modal.element.querySelector("form"), fields = form.elements;
			let awesomplete = null;
			const modelList = () => lines(fields.models.value);
			const syncAwesomplete = () => {
				const list = modelList();
				if (global.Awesomplete) { if (!awesomplete) awesomplete = new global.Awesomplete(fields.model, { list, minChars: 0 }); else awesomplete.list = list; }
				else { let datalist = form.querySelector("datalist"); if (!datalist) { datalist = this.doc.createElement("datalist"); datalist.id = "fi-model-catalog"; fields.model.setAttribute("list", "fi-model-catalog"); form.appendChild(datalist); } datalist.innerHTML = list.map((model) => "<option value=\"" + esc(model) + "\"></option>").join(""); }
			};
			const kindChanged = () => { form.querySelector("[data-base-url]").hidden = fields.kind.value !== "Custom"; fields.base_url.required = fields.kind.value === "Custom"; };
			fields.kind.addEventListener("change", kindChanged);
			fields.models.addEventListener("input", syncAwesomplete);
			const sharedChanged = () => { form.querySelector("[data-allowed-roles]").hidden = !(fields.is_shared && fields.is_shared.checked); };
			if (fields.is_shared) fields.is_shared.addEventListener("change", sharedChanged);
			let loadVersion = 0;
			const load = async (name) => { const version = ++loadVersion; await modal.run(async () => { const data = name ? await this.api("provider_details", { name }) : {}; if (version !== loadVersion || modal.closed) return; form.reset(); fields.name.value = data.name || ""; fields.title.value = data.title || ""; fields.kind.value = data.kind || "OpenAI"; fields.model.value = data.model || ""; fields.base_url.value = data.base_url || ""; fields.api_key.value = ""; fields.allowed_roles.value = data.allowed_roles || ""; fields.models.value = data.models || ""; fields.max_tokens.value = data.max_tokens || 4096; fields.timeout.value = data.timeout || 60; fields.thinking_effort.value = EFFORTS.includes(data.thinking_effort) ? data.thinking_effort : "Auto"; fields.enabled.checked = name ? !!Number(data.enabled) : true; if (fields.is_shared) fields.is_shared.checked = !!Number(data.is_shared); form.querySelector("[data-provider-heading]").textContent = name ? "Edit provider" : "Add a provider"; form.querySelector("[data-delete-provider]").hidden = !name; form.querySelector("[data-delete-provider]").dataset.confirm = ""; form.querySelector("[data-delete-provider]").textContent = "Delete provider"; kindChanged(); sharedChanged(); syncAwesomplete(); const readOnly = data.can_edit === false || !!(Number(data.is_shared) && !this.boot.is_manager); form.dataset.readOnly = String(readOnly); form.querySelector("[data-provider-note]").textContent = readOnly ? "You cannot edit this provider. Ask its owner or your system manager." : name ? "For a provider used by an existing conversation, create a new configuration to change its kind, model, or endpoint. Blank API key preserves the saved key." : "Saving stores this configuration; it does not test a paid provider request."; }); if (!modal.closed) for (const node of form.querySelectorAll("input,select,textarea,button")) node.disabled = form.dataset.readOnly === "true"; };
			modal.element.querySelectorAll("[data-provider]").forEach((element) => element.addEventListener("click", () => load(element.dataset.provider)));
			form.querySelector('[data-action="fetch-models"]').addEventListener("click", () => {
				if (form.dataset.readOnly === "true") return;
				modal.run(async () => {
					const frappe = global.frappe;
					if (frappe && frappe.ui && frappe.ui.freeze) frappe.ui.freeze("Fetching models…");
					try {
						const result = await this.api("fetch_provider_models", { name: fields.name.value || null, kind: fields.kind.value, base_url: fields.kind.value === "Custom" ? fields.base_url.value.trim() : null, api_key: fields.api_key.value || null });
						const models = result && Array.isArray(result.models) ? result.models : [];
						if (models.length) fields.models.value = models.join("\n");
						syncAwesomplete();
						if (frappe && frappe.show_alert) frappe.show_alert({ message: models.length ? models.length + " models fetched." : "No models returned by the provider.", indicator: models.length ? "green" : "orange" });
						else { this.notice = models.length ? models.length + " models fetched." : "No models returned by the provider."; this.renderBanner(); }
					} finally { if (frappe && frappe.ui && frappe.ui.unfreeze) frappe.ui.unfreeze(); }
				});
			});
			form.addEventListener("submit", (event) => { event.preventDefault(); if (form.dataset.readOnly === "true") return; const values = { name: fields.name.value || null, title: fields.title.value.trim(), kind: fields.kind.value, model: fields.model.value.trim(), thinking_effort: fields.thinking_effort.value, api_key: fields.api_key.value || null, base_url: fields.kind.value === "Custom" ? fields.base_url.value.trim() : "", enabled: fields.enabled.checked ? 1 : 0, is_shared: fields.is_shared && fields.is_shared.checked ? 1 : 0, allowed_roles: fields.allowed_roles.value, max_tokens: Number(fields.max_tokens.value), timeout: Number(fields.timeout.value), models: fields.models.value }; modal.run(async () => { await this.api("save_provider", values); fields.api_key.value = ""; this.boot = await this.api("bootstrap"); if (!this.selected && !(this.boot.providers || []).some((provider) => provider.name === this.provider)) this.provider = this.boot.providers[0] && this.boot.providers[0].name || ""; this.render(); modal.busy = false; modal.close(); this.notice = "Provider saved."; this.renderBanner(); }); });
			form.querySelector("[data-delete-provider]").addEventListener("click", () => { if (!fields.name.value || form.dataset.readOnly === "true") return; const element = form.querySelector("[data-delete-provider]"); if (element.dataset.confirm !== fields.name.value) { element.dataset.confirm = fields.name.value; element.textContent = "Confirm delete"; return; } modal.run(async () => { await this.api("delete_provider", { name: fields.name.value }); this.boot = await this.api("bootstrap"); this.provider = this.selected ? this.provider : this.boot.providers[0] && this.boot.providers[0].name || ""; this.render(); modal.busy = false; modal.close(); this.notice = "Provider deleted."; this.renderBanner(); }); });
			// First provider auto-selected; the add form when none exist.
			load(providers.length ? providers[0].name : "");
		}
		memoryDialog() {
			if (!this.boot) return;
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) return this.memoryDialogNative(frappe);
			return this.memoryDialogFallback();
		}
		memoryDialogFallback() {
			if (!this.boot) return; const conversation = this.selected;
			const modal = this.dialog("Memory", '<p class="fi-dialog-copy">Keep useful preferences and context. Memories are only read by the assistant after you approve a recall request.</p><label class="fi-field control-label">Scope<select class="form-control" data-memory-scope><option value="personal">Personal · only you</option>' + (conversation ? '<option value="conversation">This conversation</option>' : "") + '<option value="site">Site · shared with all users</option></select></label><div class="fi-memory-list" data-memory-list role="list"></div><form class="fi-memory-form"><input type="hidden" name="name"><label class="fi-field control-label"><span data-memory-heading>Add a memory</span><textarea class="form-control" name="content" rows="4" maxlength="5000" required placeholder="For example: use our fiscal year when comparing reports."></textarea></label><p class="fi-field-help" data-memory-help>Never store passwords, API keys, or other secrets in memory.</p><footer><button type="button" class="fi-btn" data-memory-reset>Clear editor</button><button type="submit" class="btn btn-primary btn-sm fi-btn fi-primary">Save memory</button></footer></form>');
			const scope = modal.element.querySelector("[data-memory-scope]"), list = modal.element.querySelector("[data-memory-list]"), form = modal.element.querySelector("form"); let memories = [];
			const reset = () => { form.reset(); form.elements.name.value = ""; form.querySelector("[data-memory-heading]").textContent = "Add a memory"; };
			const refresh = async () => { list.innerHTML = '<div class="fi-list-empty">Loading memories…</div>'; memories = await this.api("list_memories", { scope: scope.value, conversation: scope.value === "conversation" ? conversation : null }); if (modal.closed) return; const readOnly = scope.value === "site" && !this.boot.is_manager; form.hidden = readOnly; list.innerHTML = (Array.isArray(memories) && memories.length ? memories.map((memory) => '<article class="fi-memory-item" role="listitem"><p>' + esc(memory.content) + "</p>" + (!readOnly ? "<div>" + button("memory-edit", "Edit", "edit", "fi-text-btn", 'data-name="' + esc(memory.name) + '"') + button("memory-delete", "Delete", null, "fi-text-btn fi-danger", 'data-name="' + esc(memory.name) + '"') + "</div>" : "") + "</article>").join("") : '<div class="fi-memory-empty">' + icon("memory") + "<strong>No memories in this scope</strong><span>" + (readOnly ? "Site memories are managed by your administrator." : "Save a useful preference to make future work more consistent.") + "</span></div>"); };
			scope.addEventListener("change", () => { reset(); modal.run(refresh); });
			modal.element.querySelector("[data-memory-reset]").addEventListener("click", reset);
			list.addEventListener("click", (event) => { const target = event.target.closest("[data-action]"); if (!target || modal.busy) return; const memory = memories.find((entry) => entry.name === target.dataset.name); if (!memory) return; if (target.dataset.action === "memory-edit") { form.elements.name.value = memory.name; form.elements.content.value = memory.content; form.querySelector("[data-memory-heading]").textContent = "Edit memory"; form.elements.content.focus(); } else if (target.dataset.action === "memory-delete") { if (target.dataset.confirm !== "yes") { target.dataset.confirm = "yes"; target.querySelector("span").textContent = "Confirm delete"; return; } modal.run(async () => { await this.api("delete_memory", { name: memory.name }); if (form.elements.name.value === memory.name) reset(); await refresh(); }); } });
			form.addEventListener("submit", (event) => { event.preventDefault(); const content = form.elements.content.value.trim(); if (!content) return; const values = { name: form.elements.name.value || null, content, scope: scope.value, conversation: scope.value === "conversation" ? conversation : null }; modal.run(async () => { await this.api("save_memory", values); reset(); await refresh(); }); }); modal.run(refresh);
		}
		skillsDialog() {
			if (!this.boot) return;
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) return this.skillsDialogNative(frappe);
			return this.skillsDialogFallback();
		}
		skillsDialogFallback() {
			if (!this.boot) return;
			const modal = this.dialog("Skills", '<div data-skills-body><div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading skills…</div></div>');
			const body = modal.element.querySelector("[data-skills-body]");
			let data = null;
			const paint = () => { body.innerHTML = skillsHTML(data, { isManager: !!this.boot.is_manager, user: this.boot.user }); };
			const load = async () => {
				body.innerHTML = '<div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading skills…</div>';
				try { data = await this.api("skills"); if (modal.closed) return; paint(); }
				catch (error) { if (modal.closed) return; body.innerHTML = '<div class="fi-inline-error" role="alert"><p>' + esc(userError(error)) + "</p>" + button("skills-retry", "Try again", "retry") + "</div>"; }
			};
			const learned = () => (data && Array.isArray(data.learned_skills) ? data.learned_skills : []).filter((skill) => skill && skill.name);
			const editable = (skill) => !!(this.boot.is_manager || Number(skill.can_edit) === 1 || skill.can_edit === true || (this.boot.user && skill.owner && String(skill.owner) === String(this.boot.user)));
			const scopeText = (value) => Array.isArray(value) ? value.join("\n") : String(value || "");
			const edit = (skill) => {
				body.innerHTML = '<form data-form="skill-edit" class="fi-skill-edit"><h3 class="fi-section-title">Edit learned skill</h3>' + (skill.origin === "Seeded" ? '<p class="fi-skill-seeded-hint">' + icon("info") + "<span>Seeded playbook; edits are allowed.</span></p>" : "") + '<label class="fi-field control-label">Title<input class="form-control" name="title" required maxlength="140" autocomplete="off" value="' + esc(skill.title || "") + '"></label><label class="fi-field control-label">Description<textarea class="form-control" name="description" rows="2" maxlength="1000">' + esc(skill.description || "") + '</textarea></label><label class="fi-field control-label">Instructions<textarea class="form-control" name="instructions" rows="6" placeholder="What the assistant should do, step by step.">' + esc(skill.instructions || "") + '</textarea></label><div class="fi-field-row"><label class="fi-field control-label">Read scope<textarea class="form-control" name="scope_read" rows="3" placeholder="One DocType per line">' + esc(scopeText(skill.scope_read)) + '</textarea></label><label class="fi-field control-label">Write scope<textarea class="form-control" name="scope_write" rows="3" placeholder="One DocType per line">' + esc(scopeText(skill.scope_write)) + '</textarea></label></div><footer>' + button("skill-edit-cancel", "Back") + '<button type="submit" class="btn btn-primary btn-sm fi-btn fi-primary">Save skill</button></footer></form>';
				const form = body.querySelector("form");
				form.addEventListener("submit", (event) => {
					event.preventDefault();
					const fields = form.elements;
					const values = { title: fields.title.value.trim(), description: fields.description.value.trim(), instructions: fields.instructions.value, scope_read: lines(fields.scope_read.value).join("\n"), scope_write: lines(fields.scope_write.value).join("\n") };
					if (!values.title) return;
					modal.run(async () => { await this.api("frappe.client.set_value", { doctype: "Intelligence Skill", name: skill.name, fieldname: values }); await load(); });
				});
				form.elements.title.focus();
			};
			modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-action]");
				if (!target || target.disabled || modal.busy) return;
				const action = target.dataset.action;
				if (action === "skills-retry") return modal.run(load);
				if (action === "skill-edit-cancel") { paint(); return; }
				if (action === "skill-edit") { const skill = learned().find((entry) => entry.name === target.dataset.name); if (skill && editable(skill)) edit(skill); }
			});
			modal.element.addEventListener("change", (event) => {
				if (!data || modal.busy || event.target.dataset.input !== "skill-enabled") return;
				const skill = learned().find((entry) => entry.name === event.target.dataset.name);
				if (!skill || !editable(skill)) return;
				const enabled = event.target.checked ? 1 : 0;
				modal.run(async () => {
					skill.enabled = enabled; paint();
					try { await this.api("frappe.client.set_value", { doctype: "Intelligence Skill", name: skill.name, fieldname: { enabled } }); }
					catch (error) { skill.enabled = enabled ? 0 : 1; paint(); throw error; }
				});
			});
			modal.run(load);
		}
		scopeDialog() {
			if (!this.boot) return;
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) return this.scopeDialogNative(frappe);
			return this.scopeDialogFallback();
		}
		scopeDialogFallback() {
			if (!this.boot) return;
			const readOnly = !this.boot.is_manager;
			let state = null;
			const modal = this.dialog("Scope", '<div data-scope-body><div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading scope…</div></div>');
			const body = modal.element.querySelector("[data-scope-body]");
			const paint = () => { body.innerHTML = scopeHTML(state, { readOnly }); };
			const load = async () => {
				body.innerHTML = '<div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading scope…</div>';
				try {
					const results = await Promise.all([this.api("skills"), this.api("frappe.client.get", { doctype: "Intelligence Settings", name: "Intelligence Settings" })]);
					if (modal.closed) return; state = scopeState(results[1], results[0]); paint();
				} catch (error) { if (modal.closed) return; body.innerHTML = '<div class="fi-inline-error" role="alert"><p>' + esc(userError(error)) + "</p>" + button("scope-retry", "Try again", "retry") + "</div>"; }
			};
			modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-action]");
				if (!target || target.disabled || modal.busy) return;
				const action = target.dataset.action;
				if (action === "scope-retry") return modal.run(load);
				if (!state) return;
				if (action === "scope-add" || action === "scope-remove") {
					const key = target.dataset.list;
					if (!["read", "write"].includes(key)) return;
					if (action === "scope-add") {
						const input = body.querySelector('[data-input="scope-add-' + key + '"]'), value = input.value.trim();
						if (!value) { input.focus(); return; }
						if (!state[key].includes(value)) state[key].push(value);
						paint();
						const next = body.querySelector('[data-input="scope-add-' + key + '"]'); if (next) next.focus();
					} else { state[key] = state[key].filter((value) => value !== target.dataset.value); paint(); }
					return;
				}
				if (action === "scope-save") {
					const problem = scopeProblem(state);
					if (problem) { const box = modal.element.querySelector(".fi-modal-error"); if (box) { box.hidden = false; box.textContent = problem; } return; }
					modal.run(async () => {
						await this.api("save_settings", { enabled_tools: state.tools.filter((tool) => tool.enabled).map((tool) => tool.name).join("\n"), allowed_read_doctypes: state.read.join("\n"), allowed_write_doctypes: state.write.join("\n") });
						modal.busy = false; modal.close(); this.notice = "Scope saved."; this.renderBanner();
					});
				}
			});
			modal.element.addEventListener("change", (event) => {
				if (!state || event.target.dataset.input !== "scope-tool") return;
				const tool = state.tools.find((entry) => entry.name === event.target.value);
				if (tool) tool.enabled = event.target.checked;
			});
			modal.element.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" || !event.target.dataset || !String(event.target.dataset.input || "").startsWith("scope-add-")) return;
				event.preventDefault();
				const trigger = body.querySelector('[data-action="scope-add"][data-list="' + event.target.dataset.input.slice(10) + '"]');
				if (trigger) trigger.click();
			});
			modal.run(load);
		}
		// Native Desk path: the provider editor as one declarative frappe.ui.Dialog
		// form. The provider picker stays an HTML field so switching providers does
		// not rebuild the dialog; everything else is a native control.
		async providerDialogNative(frappe) {
			const providers = this.boot.managed_providers || this.boot.providers || [];
			const isManager = !!this.boot.is_manager;
			let loadVersion = 0, readOnly = false, modal = null, catalogOptions = [];
			const listHTML = '<nav class="fi-provider-list fi-provider-list-native" aria-label="Configured providers">'
				+ providers.map((provider) => '<button type="button" data-provider="' + esc(provider.name) + '"><strong>' + esc(provider.title) + "</strong><span>" + esc(provider.kind + " · " + provider.model) + "</span></button>").join("")
				+ '<button type="button" data-provider="">' + icon("plus") + " Add provider</button></nav>";
			const syncPrimary = () => { try { const primary = modal && modal.instance && modal.instance.get_primary_btn && modal.instance.get_primary_btn(); if (primary && primary.prop) primary.prop("disabled", readOnly); } catch (_) { /* stub hosts */ } };
			const fetchModels = () => {
				if (readOnly || !modal) return;
				const values = modal.values();
				modal.run(async () => {
					if (frappe.ui.freeze) frappe.ui.freeze("Fetching models…");
					try {
						const result = await this.api("fetch_provider_models", { name: values.name || null, kind: values.kind || "OpenAI", base_url: values.kind === "Custom" ? String(values.base_url || "").trim() : null, api_key: values.api_key || null });
						const models = result && Array.isArray(result.models) ? result.models : [];
						catalogOptions = models.slice();
						if (models.length) modal.set("models", models.join(", "));
						if (frappe.show_alert) frappe.show_alert({ message: models.length ? models.length + " models fetched." : "No models returned by the provider.", indicator: models.length ? "green" : "orange" });
					} finally { if (frappe.ui.unfreeze) frappe.ui.unfreeze(); }
				});
			};
			const load = async (name) => {
				const version = ++loadVersion;
				await modal.run(async () => {
					const data = name ? await this.api("provider_details", { name }) : {};
					if (version !== loadVersion || modal.closed) return;
					readOnly = !!(name && (data.can_edit === false || (Number(data.is_shared) && !isManager)));
					catalogOptions = lines(data.models || "");
					if (modal.instance.set_values) await modal.instance.set_values({
						name: data.name || "", title: data.title || "", kind: data.kind || "OpenAI", model: data.model || "",
						base_url: data.base_url || "", api_key: "", allowed_roles: data.allowed_roles || "", models: catalogOptions.join(", "),
						max_tokens: data.max_tokens || 4096, timeout: data.timeout || 60,
						thinking_effort: EFFORTS.includes(data.thinking_effort) ? data.thinking_effort : "Auto",
						enabled: name ? (Number(data.enabled) ? 1 : 0) : 1, is_shared: Number(data.is_shared) ? 1 : 0
					});
					modal.setReadOnly(readOnly);
					syncPrimary();
					const del = modal.element && modal.element.querySelector("[data-native-delete]");
					if (del) { del.hidden = !name || readOnly; del.dataset.confirm = ""; del.textContent = "Delete provider"; }
				});
			};
			modal = this.nativeForm(frappe, {
				title: "Providers & models",
				fields: [
					{ fieldtype: "HTML", fieldname: "provider_list", options: '<p class="fi-dialog-copy">Bring your own provider. Credentials stay on the server and are never shown here.</p>' + listHTML },
					{ fieldname: "name", fieldtype: "Data", hidden: 1 },
					{ fieldname: "title", label: "Name", fieldtype: "Data", reqd: 1 },
					{ fieldname: "kind", label: "Provider", fieldtype: "Select", options: KINDS, default: "OpenAI" },
					{ fieldname: "model", label: "Model ID", fieldtype: "Data", reqd: 1 },
					{ fieldname: "fetch_models", fieldtype: "Button", label: "Fetch models", click: () => fetchModels() },
					{ fieldname: "thinking_effort", label: "Thinking effort", fieldtype: "Select", options: EFFORTS, default: "Auto" },
					{ fieldname: "api_key", label: "API key", fieldtype: "Password", description: "Stored keys are never shown; leave blank to keep the current key." },
					{ fieldname: "base_url", label: "Custom endpoint URL", fieldtype: "Data", depends_on: 'eval:doc.kind=="Custom"', description: "HTTPS only. The hostname must be allowlisted by your administrator." },
					{ fieldname: "enabled", label: "Enabled", fieldtype: "Check", default: 1 },
					...(isManager ? [{ fieldname: "is_shared", label: "Shared with this site", fieldtype: "Check" }, { fieldname: "allowed_roles", label: "Allowed roles", fieldtype: "Small Text", depends_on: "eval:doc.is_shared==1", description: "One Frappe role per line. Blank allows all authorized Intelligence users." }] : []),
					{ fieldname: "max_tokens", label: "Output token limit", fieldtype: "Int", default: 4096 },
					{ fieldname: "timeout", label: "Timeout (seconds)", fieldtype: "Int", default: 60 },
					{ fieldname: "models", label: "Model catalog", fieldtype: "MultiSelect", ignore_validation: 1, get_data: () => catalogOptions, description: "Model IDs offered in the composer picker. Blank allows any model." },
					{ fieldtype: "HTML", fieldname: "provider_actions", options: '<button type="button" class="fi-btn fi-danger" data-native-delete hidden>Delete provider</button>' }
				],
				primary_action_label: "Save provider",
				primary_action: async (values, m) => {
					if (readOnly) return;
					const kind = values.kind || "OpenAI", baseURL = kind === "Custom" ? String(values.base_url || "").trim() : "";
					if (kind === "Custom" && !baseURL) { m.error({ userMessage: "Enter the custom endpoint URL for a Custom provider." }); return; }
					await this.api("save_provider", {
						name: values.name || null, title: String(values.title || "").trim(), kind,
						model: String(values.model || "").trim(), thinking_effort: values.thinking_effort || "Auto",
						api_key: values.api_key || null, base_url: baseURL,
						enabled: values.enabled ? 1 : 0, is_shared: values.is_shared ? 1 : 0,
						allowed_roles: values.allowed_roles || "", max_tokens: Number(values.max_tokens) || 4096,
						timeout: Number(values.timeout) || 60, models: String(values.models || "").split(",").map((entry) => entry.trim()).filter(Boolean).join("\n")
					});
					this.boot = await this.api("bootstrap");
					if (!this.selected && !(this.boot.providers || []).some((provider) => provider.name === this.provider)) this.provider = this.boot.providers[0] && this.boot.providers[0].name || "";
					this.render();
					m.busy = false; m.close();
					this.notice = "Provider saved."; this.renderBanner();
				}
			});
			if (modal.element) {
				modal.element.querySelectorAll("[data-provider]").forEach((element) => element.addEventListener("click", () => load(element.dataset.provider)));
				const del = modal.element.querySelector("[data-native-delete]");
				if (del) del.addEventListener("click", () => {
					const values = modal.values(), name = values.name;
					if (!name || readOnly) return;
					if (del.dataset.confirm !== name) { del.dataset.confirm = name; del.textContent = "Confirm delete"; return; }
					modal.run(async () => {
						await this.api("delete_provider", { name });
						this.boot = await this.api("bootstrap");
						this.provider = this.selected ? this.provider : this.boot.providers[0] && this.boot.providers[0].name || "";
						this.render();
						modal.busy = false; modal.close();
						this.notice = "Provider deleted."; this.renderBanner();
					});
				});
			}
			load(providers.length ? providers[0].name : "");
		}
		memoryDialogNative(frappe) {
			if (!this.boot) return;
			const conversation = this.selected, isManager = !!this.boot.is_manager;
			const scopeOptions = [{ value: "personal", label: "Personal · only you" }];
			if (conversation) scopeOptions.push({ value: "conversation", label: "This conversation" });
			scopeOptions.push({ value: "site", label: "Site · shared with all users" });
			let modal = null, memories = [];
			const scope = () => modal && modal.instance && modal.instance.get_value ? modal.instance.get_value("memory_scope") || "personal" : "personal";
			const readOnlyScope = () => scope() === "site" && !isManager;
			const listHost = () => { const host = modal && modal.bodyHost(); return host && host.querySelector("[data-memory-list]"); };
			const syncEditor = () => {
				const ro = readOnlyScope();
				try { if (modal.instance.set_df_property) modal.instance.set_df_property("content", "read_only", ro ? 1 : 0); } catch (_) { /* stub hosts */ }
				try { const primary = modal.instance.get_primary_btn && modal.instance.get_primary_btn(); if (primary && primary.prop) primary.prop("disabled", ro); } catch (_) { /* stub hosts */ }
			};
			const paintList = () => {
				const host = listHost(); if (!host) return;
				const ro = readOnlyScope();
				host.innerHTML = (Array.isArray(memories) && memories.length ? memories.map((memory) => '<article class="fi-memory-item" role="listitem"><p>' + esc(memory.content) + "</p>" + (!ro ? "<div>" + button("memory-edit", "Edit", "edit", "fi-text-btn", 'data-name="' + esc(memory.name) + '"') + button("memory-delete", "Delete", null, "fi-text-btn fi-danger", 'data-name="' + esc(memory.name) + '"') + "</div>" : "") + "</article>").join("") : '<div class="fi-memory-empty">' + icon("memory") + "<strong>No memories in this scope</strong><span>" + (ro ? "Site memories are managed by your administrator." : "Save a useful preference to make future work more consistent.") + "</span></div>");
			};
			const refresh = async () => {
				if (!modal) return;
				const host = listHost(); if (host) host.innerHTML = '<div class="fi-list-empty">Loading memories…</div>';
				memories = await this.api("list_memories", { scope: scope(), conversation: scope() === "conversation" ? conversation : null });
				if (modal.closed) return;
				paintList(); syncEditor();
			};
			modal = this.nativeForm(frappe, {
				title: "Memory",
				fields: [
					{ fieldtype: "HTML", fieldname: "memory_copy", options: '<p class="fi-dialog-copy">Keep useful preferences and context. Memories are only read by the assistant after you approve a recall request. Never store passwords, API keys, or other secrets in memory.</p>' },
					{ fieldname: "memory_scope", label: "Scope", fieldtype: "Select", options: scopeOptions, default: "personal", onchange: () => { if (modal && modal.instance) modal.run(refresh); } },
					{ fieldtype: "HTML", fieldname: "memory_list", options: '<div class="fi-memory-list" data-memory-list role="list"></div>' },
					{ fieldname: "name", fieldtype: "Data", hidden: 1 },
					{ fieldname: "content", label: "Memory", fieldtype: "Small Text", reqd: 1, description: "For example: use our fiscal year when comparing reports." }
				],
				primary_action_label: "Save memory",
				primary_action: async (values, m) => {
					if (readOnlyScope()) return;
					const content = String(values.content || "").trim();
					if (!content) { m.error({ userMessage: "Write the memory before saving." }); return; }
					await this.api("save_memory", { name: values.name || null, content, scope: scope(), conversation: scope() === "conversation" ? conversation : null });
					m.set("name", ""); m.set("content", "");
					await refresh();
				},
				secondary_action_label: "Clear editor",
				secondary_action: (m) => { m.set("name", ""); m.set("content", ""); }
			});
			if (modal.element) modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-action]");
				if (!target || modal.busy) return;
				const memory = memories.find((entry) => entry.name === target.dataset.name);
				if (!memory) return;
				if (target.dataset.action === "memory-edit") { modal.set("name", memory.name); modal.set("content", memory.content); }
				else if (target.dataset.action === "memory-delete") {
					if (target.dataset.confirm !== "yes") { target.dataset.confirm = "yes"; const span = target.querySelector("span"); if (span) span.textContent = "Confirm delete"; return; }
					modal.run(async () => { await this.api("delete_memory", { name: memory.name }); await refresh(); });
				}
			});
			modal.run(refresh);
		}
		async skillsDialogNative(frappe) {
			if (!this.boot) return;
			if (frappe.ui.freeze) frappe.ui.freeze("Loading skills…");
			let data;
			try { data = await this.api("skills"); }
			catch (error) { this.error = userError(error); this.renderBanner(); return; }
			finally { if (frappe.ui.unfreeze) frappe.ui.unfreeze(); }
			const isManager = !!this.boot.is_manager, user = this.boot.user;
			const learned = (Array.isArray(data && data.learned_skills) ? data.learned_skills : []).filter((skill) => skill && skill.name);
			const editable = (skill) => !!(isManager || Number(skill.can_edit) === 1 || skill.can_edit === true || (user && skill.owner && String(skill.owner) === String(user)));
			const enabled = (skill) => skill.enabled === undefined ? true : !!Number(skill.enabled);
			const overview = skillsHTML(Object.assign({}, data, { learned_skills: [] }), { isManager, user });
			let modal = null, reverting = false;
			const fields = [{ fieldtype: "HTML", fieldname: "skills_overview", options: overview }];
			if (learned.length) fields.push({ fieldtype: "HTML", fieldname: "learned_heading", options: '<h3 class="fi-section-title">Learned skills</h3>' });
			for (const skill of learned) {
				const fieldname = "skill_" + String(skill.name).replace(/[^\w]/g, "_");
				fields.push({ fieldtype: "HTML", fieldname: fieldname + "_meta", options: '<div class="fi-skill-meta"><code>' + esc(skill.name) + '</code> <span class="fi-badge fi-badge-origin">' + (skill.origin === "Seeded" ? "Seeded" : "Learned") + "</span>" + (skill.version ? ' <span class="fi-skill-version">v' + esc(skill.version) + "</span>" : "") + '<p class="fi-skill-desc">' + esc(skill.description || "") + "</p>" + (editable(skill) ? '<button type="button" class="fi-btn fi-text-btn" data-skill-edit="' + esc(skill.name) + '">' + icon("edit") + "<span>Edit</span></button>" : "") + "</div>" });
				fields.push({
					fieldname, label: skill.title || skill.name, fieldtype: "Check",
					default: enabled(skill) ? 1 : 0, read_only: editable(skill) ? 0 : 1,
					description: "Enabled",
					onchange: () => {
						if (reverting || !modal || !modal.instance || !modal.instance.get_value) return;
						const value = modal.instance.get_value(fieldname) ? 1 : 0;
						modal.run(async () => {
							try { await this.api("frappe.client.set_value", { doctype: "Intelligence Skill", name: skill.name, fieldname: { enabled: value } }); }
							catch (error) { reverting = true; try { if (modal.instance.set_value) await modal.instance.set_value(fieldname, value ? 0 : 1); } finally { reverting = false; } throw error; }
						});
					}
				});
			}
			modal = this.nativeForm(frappe, { title: "Skills", fields });
			if (modal.element) modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-skill-edit]");
				if (!target || modal.busy) return;
				const skill = learned.find((entry) => entry.name === target.dataset.skillEdit);
				if (skill && editable(skill)) this.skillEditNative(frappe, skill);
			});
		}
		skillEditNative(frappe, skill) {
			const scopeText = (value) => Array.isArray(value) ? value.join("\n") : String(value || "");
			this.nativeForm(frappe, {
				title: "Edit learned skill",
				fields: [
					{ fieldname: "title", label: "Title", fieldtype: "Data", reqd: 1, default: skill.title || "" },
					{ fieldname: "description", label: "Description", fieldtype: "Small Text", default: skill.description || "" },
					{ fieldname: "instructions", label: "Instructions", fieldtype: "Small Text", default: skill.instructions || "", description: "What the assistant should do, step by step." },
					{ fieldname: "scope_read", label: "Read scope", fieldtype: "Small Text", default: scopeText(skill.scope_read), description: "One DocType per line." },
					{ fieldname: "scope_write", label: "Write scope", fieldtype: "Small Text", default: scopeText(skill.scope_write), description: "One DocType per line. Writable doctypes must also be readable." }
				],
				primary_action_label: "Save skill",
				primary_action: async (values, m) => {
					const title = String(values.title || "").trim();
					if (!title) { m.error({ userMessage: "Give the skill a title." }); return; }
					await this.api("frappe.client.set_value", { doctype: "Intelligence Skill", name: skill.name, fieldname: { title, description: String(values.description || "").trim(), instructions: values.instructions || "", scope_read: lines(values.scope_read).join("\n"), scope_write: lines(values.scope_write).join("\n") } });
					m.busy = false; m.close();
					this.notice = "Skill saved."; this.renderBanner();
					this.skillsDialog();
				},
				secondary_action_label: "Back",
				secondary_action: (m) => { m.close(); this.skillsDialog(); }
			});
		}
		async scopeDialogNative(frappe) {
			if (!this.boot) return;
			const readOnly = !this.boot.is_manager;
			if (frappe.ui.freeze) frappe.ui.freeze("Loading scope…");
			let state;
			try {
				const results = await Promise.all([this.api("skills"), this.api("frappe.client.get", { doctype: "Intelligence Settings", name: "Intelligence Settings" })]);
				state = scopeState(results[1], results[0]);
			} catch (error) { this.error = userError(error); this.renderBanner(); return; }
			finally { if (frappe.ui.unfreeze) frappe.ui.unfreeze(); }
			const toolField = (tool) => "tool_" + tool.name.replace(/[^\w]/g, "_");
			const fields = [
				{ fieldtype: "HTML", fieldname: "scope_copy", options: '<p class="fi-dialog-copy">' + (readOnly ? "Only system managers can change scope. Your effective access is shown here." : "Choose the tools and record types Intelligence may use. The server re-validates every save.") + '</p><h3 class="fi-section-title">Enabled tools</h3>' },
				...state.tools.map((tool) => ({ fieldname: toolField(tool), label: tool.name, fieldtype: "Check", default: tool.enabled ? 1 : 0, read_only: readOnly ? 1 : 0, description: tool.description + (tool.mutates ? " Writes records." : "") })),
				{ fieldname: "allowed_read_doctypes", label: "Readable doctypes", fieldtype: "Small Text", default: state.read.join("\n"), read_only: readOnly ? 1 : 0, description: "One DocType per line." },
				{ fieldname: "allowed_write_doctypes", label: "Writable doctypes", fieldtype: "Small Text", default: state.write.join("\n"), read_only: readOnly ? 1 : 0, description: "One DocType per line. Writable doctypes must also be readable. " + (state.never_allow.length ? "Always off-limits: " + state.never_allow.join(", ") + "." : "Some record types are always off-limits.") }
			];
			this.nativeForm(frappe, {
				title: "Scope",
				fields,
				primary_action_label: readOnly ? undefined : "Save scope",
				primary_action: readOnly ? undefined : async (values, modal) => {
					const next = { tools: state.tools.map((tool) => Object.assign({}, tool, { enabled: !!values[toolField(tool)] })), read: lines(values.allowed_read_doctypes), write: lines(values.allowed_write_doctypes), never_allow: state.never_allow };
					const problem = scopeProblem(next);
					if (problem) { modal.error({ userMessage: problem }); return; }
					await this.api("save_settings", { enabled_tools: next.tools.filter((tool) => tool.enabled).map((tool) => tool.name).join("\n"), allowed_read_doctypes: next.read.join("\n"), allowed_write_doctypes: next.write.join("\n") });
					modal.busy = false; modal.close();
					this.notice = "Scope saved."; this.renderBanner();
				}
			});
		}
		settingsDialog() {
			if (!this.boot) return;
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) return this.settingsDialogNative(frappe);
			return this.settingsDialogFallback();
		}
		settingsValues(source) {
			const out = {};
			for (const field of SETTINGS_FIELDS) {
				let value = source ? source[field.fieldname] : undefined;
				if (value && typeof value === "object") value = field.fieldtype === "Check" ? (value.checked ? 1 : 0) : value.value;
				if (field.fieldtype === "Check") out[field.fieldname] = value ? 1 : 0;
				else if (field.fieldtype === "Int") out[field.fieldname] = Number(value) || 0;
				else out[field.fieldname] = value == null ? "" : String(value);
			}
			return out;
		}
		ragStatusHTML() {
			const rag = this.boot && this.boot.rag;
			if (!rag) return "";
			const available = !!rag.available;
			const detail = available
				? "Available through " + esc(rag.provider || "a configured provider") + (rag.model ? " (" + esc(rag.model) + ")" : "") + ". Uploaded files and knowledge sources are searched for context."
				: esc(rag.reason || "Not offered by the configured providers.");
			return '<div class="fi-rag-status' + (available ? " is-available" : "") + '" role="status">' + icon(available ? "check" : "info") + '<div class="fi-rag-copy"><strong>Context retrieval (RAG)</strong><span>' + detail + "</span></div></div>";
		}
		async settingsDialogNative(frappe) {
			const readOnly = !this.boot.is_manager;
			let data;
			if (frappe.ui.freeze) frappe.ui.freeze("Loading settings…");
			try { data = await this.api("get_settings"); }
			catch (error) { this.error = userError(error); this.renderBanner(); return; }
			finally { if (frappe.ui.unfreeze) frappe.ui.unfreeze(); }
			const intro = [{ fieldtype: "HTML", fieldname: "settings_copy", options: '<p class="fi-dialog-copy">' + (readOnly ? "Only system managers can change these settings. Your current configuration is shown here." : "Site-wide assistant behavior. Changes apply to every user and every run.") + "</p>" }];
			if (this.boot.rag) intro.push({ fieldtype: "HTML", fieldname: "rag_status", options: this.ragStatusHTML() });
			const fields = intro.concat(SETTINGS_FIELDS.map((field) => Object.assign({}, field, { default: data && data[field.fieldname] !== undefined && data[field.fieldname] !== null ? data[field.fieldname] : field.fieldtype === "Check" ? 0 : "", read_only: readOnly ? 1 : 0 })));
			this.nativeForm(frappe, {
				title: "Intelligence settings",
				fields,
				primary_action_label: readOnly ? undefined : "Save settings",
				primary_action: readOnly ? undefined : async (values, modal) => {
					await this.api("save_settings", this.settingsValues(values));
					this.boot = await this.api("bootstrap");
					modal.busy = false; modal.close();
					this.render();
					this.notice = "Settings saved."; this.renderBanner();
				}
			});
		}
		settingsFieldHTML(field, value, readOnly) {
			const off = readOnly ? " disabled" : "", val = value == null ? "" : value;
			const help = field.description ? "<span>" + esc(field.description) + "</span>" : "";
			if (field.fieldtype === "Check") return '<label class="fi-check-field"><input type="checkbox" name="' + field.fieldname + '"' + (Number(val) ? " checked" : "") + off + "> " + esc(field.label) + help + "</label>";
			if (field.fieldtype === "Select") return '<label class="fi-field control-label">' + esc(field.label) + '<select class="form-control" name="' + field.fieldname + '"' + off + ">" + field.options.map((option) => '<option' + (option === val ? " selected" : "") + ">" + esc(option) + "</option>").join("") + "</select>" + help + "</label>";
			if (field.fieldtype === "Small Text") return '<label class="fi-field control-label">' + esc(field.label) + '<textarea class="form-control" name="' + field.fieldname + '" rows="3"' + off + ">" + esc(val) + "</textarea>" + help + "</label>";
			return '<label class="fi-field control-label">' + esc(field.label) + '<input class="form-control" name="' + field.fieldname + '" type="' + (field.fieldtype === "Int" ? "number" : "text") + '" value="' + esc(val) + '"' + off + ">" + help + "</label>";
		}
		async settingsDialogFallback() {
			const readOnly = !this.boot.is_manager;
			const modal = this.dialog("Intelligence settings", '<p class="fi-dialog-copy">' + (readOnly ? "Only system managers can change these settings. Your current configuration is shown here." : "Site-wide assistant behavior. Changes apply to every user and every run.") + '</p><form class="fi-settings-form"><div data-settings-body><div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading settings…</div></div>' + (readOnly ? "" : '<footer><button type="submit" class="btn btn-primary btn-sm fi-btn fi-primary">Save settings</button></footer>') + "</form>");
			const body = modal.element.querySelector("[data-settings-body]"), form = modal.element.querySelector("form");
			let data;
			try { data = await this.api("get_settings"); }
			catch (error) { if (!modal.closed) body.innerHTML = '<div class="fi-inline-error" role="alert"><p>' + esc(userError(error)) + "</p></div>"; return; }
			if (modal.closed) return;
			body.innerHTML = this.ragStatusHTML() + SETTINGS_FIELDS.map((field) => this.settingsFieldHTML(field, data[field.fieldname], readOnly)).join("");
			for (const field of SETTINGS_FIELDS) {
				const input = form.elements[field.fieldname];
				if (!input) continue;
				const value = data[field.fieldname];
				if (field.fieldtype === "Check") input.checked = !!Number(value);
				else if (value != null) input.value = String(value);
			}
			if (readOnly) return;
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				const values = this.settingsValues(form.elements);
				modal.run(async () => {
					await this.api("save_settings", values);
					this.boot = await this.api("bootstrap");
					modal.busy = false; modal.close();
					this.render();
					this.notice = "Settings saved."; this.renderBanner();
				});
			});
		}
	}
	function trapFocus(event, container) {
		const nodes = Array.from(container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter((node) => !node.closest("[hidden]") && (node.getClientRects ? node.getClientRects().length : true));
		if (!nodes.length) { event.preventDefault(); return; } const first = nodes[0], last = nodes[nodes.length - 1];
		if (event.shiftKey && (global.document.activeElement === first || !container.contains(global.document.activeElement))) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (global.document.activeElement === last || !container.contains(global.document.activeElement))) { event.preventDefault(); first.focus(); }
	}
	Object.assign(fi, { API, LOGO, ACTIVE, KINDS, EFFORTS, APPROVAL_MODES, SETTINGS_FIELDS, LABELS, PAGE, icons, icon, esc, contextFromRoute, userError, request, button, iconButton, time, stamp, parsed, dashed, effortOptions, skillsHTML, learnedSkillsHTML, lines, scopeState, scopeProblem, scopeHTML, mergeMessages, App, trapFocus });
	fi.utils = { esc, contextFromRoute, userError, skillsHTML, learnedSkillsHTML, effortOptions, scopeState, scopeProblem, scopeHTML, stamp };
	return fi;
});
