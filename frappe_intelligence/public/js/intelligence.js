/* Intelligence - dependency-free Desk client. No provider credentials or chat data are stored in browser storage. */
(function (global, factory) {
	"use strict";
	const client = factory(global);
	if (typeof module === "object" && module.exports) module.exports = client;
	if (global.frappe) {
		global.frappe.intelligence = client;
		if (global.document) {
			if (global.jQuery) global.jQuery(global.document).on("app_ready.intelligence", client.install);
			if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", client.install, { once: true });
			else client.install();
		}
	}
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const API = "frappe_intelligence.api.";
	const ACTIVE = new Set(["queued", "running", "awaiting_approval"]);
	const KINDS = ["OpenAI", "Anthropic", "Gemini", "OpenRouter", "xAI", "Custom"];
	const LABELS = { queued: "Queued", running: "Working", awaiting_approval: "Needs your approval", completed: "Completed", failed: "Run failed", cancelled: "Cancelled", needs_reconciliation: "Needs review" };
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
		expand: '<path d="M14 3h7v7m0-7-8 8M10 21H3v-7m0 7 8-8"/>',
		file: '<path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h5"/>',
		retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
		stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
		grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
		queue: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L6.8 5M3.5 12l1.2 1.2L6.8 11M3.5 18l1.2 1.2L6.8 17"/>',
		target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>'
	};
	function icon(name) { return '<svg class="fi-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.chat) + '</svg>'; }
	function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
	function safeURL(value) {
		const raw = String(value || "").trim();
		if (!raw || /[\x00-\x20\x7f\\]/.test(raw) || raw.startsWith("//")) return "";
		if (raw.startsWith("/")) {
			try { const local = new URL(raw, "https://intelligence.invalid"); return /^\/((?:app|desk)(?:\/|$)|private\/files\/|files\/)/.test(local.pathname) && !/%(?:00|0a|0d|5c)/i.test(raw) ? local.pathname + local.search + local.hash : ""; } catch (_) { return ""; }
		}
		try { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; } catch (_) { return ""; }
	}
	function inline(text) {
		// Tokenize before escaping. Never pass model HTML through a Markdown/HTML renderer.
		const pattern = /(`[^`\n]+`|!\[[^\]\n]*\]\([^\s)]*\)|\[[^\]\n]+\]\([^\s)]*\)|\*\*[^*\n]+\*\*)/g;
		let output = "", cursor = 0;
		for (const match of String(text).matchAll(pattern)) {
			output += esc(text.slice(cursor, match.index)); const token = match[0];
			if (token[0] === "`") output += "<code>" + esc(token.slice(1, -1)) + "</code>";
			else if (token.startsWith("**")) output += "<strong>" + esc(token.slice(2, -2)) + "</strong>";
			else if (token.startsWith("!")) output += '<span class="fi-muted">[Image not loaded]</span>';
			else { const link = token.match(/^\[([^\]]+)\]\(([^)]*)\)$/); const href = safeURL(link[2]); output += href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(link[1]) + "</a>" : esc(link[1]); }
			cursor = match.index + token.length;
		}
		return output + esc(text.slice(cursor));
	}
	function markdown(value) {
		const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
		let html = "", paragraph = [], list = "", code = null, lang = "";
		const flush = () => { if (paragraph.length) { html += "<p>" + paragraph.map(inline).join("<br>") + "</p>"; paragraph = []; } if (list) { html += "</" + list + ">"; list = ""; } };
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*```/.test(line)) {
				if (code !== null) { html += '<div class="fi-code"><div class="fi-code-head"><span>' + esc(lang || "Code") + '</span><button type="button" data-action="copy-code">Copy</button></div><pre><code>' + esc(code.join("\n")) + "</code></pre></div>"; code = null; }
				else { flush(); code = []; lang = line.trim().slice(3).trim(); } continue;
			}
			if (code !== null) { code.push(line); continue; }
			if (!line.trim()) { flush(); continue; }
			const heading = line.match(/^(#{1,3})\s+(.+)$/);
			if (heading) { flush(); const level = heading[1].length + 2; html += "<h" + level + ">" + inline(heading[2]) + "</h" + level + ">"; continue; }
			if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
				flush(); const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
				html += '<div class="fi-table-wrap"><table><thead><tr>' + cells(line).map((cell) => "<th>" + inline(cell) + "</th>").join("") + "</tr></thead><tbody>"; i++;
				while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) html += "<tr>" + cells(lines[++i]).map((cell) => "<td>" + inline(cell) + "</td>").join("") + "</tr>";
				html += "</tbody></table></div>"; continue;
			}
			const item = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
			if (item) { const type = item[1] ? "ul" : "ol"; if (paragraph.length || (list && list !== type)) flush(); if (!list) { list = type; html += "<" + type + ">"; } html += "<li>" + inline(item[2]) + "</li>"; continue; }
			if (list) flush();
			if (/^>\s?/.test(line)) { flush(); html += "<blockquote>" + inline(line.replace(/^>\s?/, "")) + "</blockquote>"; } else paragraph.push(line);
		}
		flush(); if (code !== null) html += '<div class="fi-code"><pre><code>' + esc(code.join("\n")) + "</code></pre></div>";
		return html;
	}
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
	function previewHTML(preview) {
		const data = parsed(preview, { summary: String(preview || "Review the requested action before continuing.") });
		if (typeof data !== "object" || !data) return '<p class="fi-approval-summary">' + esc(data) + '</p>';
		const summary = data.summary || data.description || "Review the exact request below. Only approve access and changes you expect.";
		const value = (entry) => typeof entry === "object" && entry !== null ? JSON.stringify(entry, null, 2) : String(entry == null ? "-" : entry);
		let html = '<p class="fi-approval-summary">' + esc(summary) + '</p>';
		if (data.operation || data.target) html += '<div class="fi-proposal-target">' + icon("file") + '<span>' + esc(data.operation || "Requested action") + '</span>' + Object.entries(data.target || {}).map(([key, entry]) => '<span class="fi-proposal-tag"><span>' + esc(key.replace(/_/g, " ")) + '</span>' + esc(value(entry)) + '</span>').join("") + '</div>';
		if (Array.isArray(data.changes) && data.changes.length) html += '<div class="fi-change-table"><table><thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead><tbody>' + data.changes.map((change) => '<tr><th>' + esc(change.label || change.field) + '</th><td>' + esc(value(change.before)) + '</td><td>' + esc(value(change.after)) + '</td></tr>').join("") + '</tbody></table></div>';
		// Only the server's purpose-built approval preview is displayed. Never render model tool-call metadata.
		const details = Object.fromEntries(Object.entries(data).filter(([key]) => !["summary", "description", "metadata", "operation", "target", "changes"].includes(key)));
		if (Object.keys(details).length) html += '<details class="fi-proposal"><summary>Review exact fields and filters</summary><pre>' + esc(JSON.stringify(details.details && Object.keys(details).length === 1 ? details.details : details, null, 2)) + '</pre></details>';
		return html;
	}
	function skillsHTML(data) {
		const source = data && typeof data === "object" ? data : {};
		const tools = (Array.isArray(source.tools) ? source.tools : []).filter((tool) => tool && tool.name);
		const scopes = source.scopes && typeof source.scopes === "object" ? source.scopes : {};
		const never = Array.isArray(source.never_allow) ? source.never_allow : [];
		const chips = (list, empty) => {
			const values = Array.isArray(list) ? list : [];
			return values.length ? '<div class="fi-chip-list">' + values.map((item) => '<span class="fi-chip">' + esc(item) + "</span>").join("") + "</div>" : '<p class="fi-section-empty fi-muted">' + esc(empty) + "</p>";
		};
		return '<div class="fi-skills"><h3 class="fi-section-title">Tools</h3>' + (tools.length ? '<div class="fi-skill-list">' + tools.map((tool) => '<div class="fi-skill-row"><div class="fi-skill-head"><code>' + esc(tool.name) + "</code>" + (tool.mutates ? '<span class="fi-badge fi-badge-writes">Writes</span>' : "") + (tool.external ? '<span class="fi-badge">External</span>' : "") + (tool.enabled === false ? '<span class="fi-badge">Off</span>' : "") + (tool.version ? '<span class="fi-skill-version">v' + esc(tool.version) + "</span>" : "") + '</div><p class="fi-skill-desc">' + esc(tool.description || "") + "</p></div>").join("") + "</div>" : '<p class="fi-section-empty fi-muted">No tools are currently enabled.</p>') + '<h3 class="fi-section-title">Readable doctypes</h3>' + chips(scopes.read, "No readable doctypes are configured.") + '<h3 class="fi-section-title">Writable doctypes</h3>' + chips(scopes.write, "No writable doctypes are configured.") + '<p class="fi-never-note">' + icon("lock") + "<span>" + (never.length ? "Always off-limits, whatever the configuration: " + never.map((item) => esc(item)).join(", ") + "." : "Some record types are always off-limits, whatever the configuration.") + "</span></p></div>";
	}
	function queueHTML(rows) {
		const list = (Array.isArray(rows) ? rows : []).filter((row) => row && row.name);
		if (!list.length) return '<div class="fi-queue-empty">' + icon("check") + "<strong>No pending approvals</strong><span>Requests from any of your conversations will appear here.</span></div>";
		return '<div class="fi-queue-list" role="list">' + list.map((row) => {
			const data = row.preview_json != null ? parsed(row.preview_json, {}) : row.preview && typeof row.preview === "object" ? row.preview : {};
			const target = data && typeof data.target === "object" && data.target ? data.target : {};
			const summary = data && (data.summary || data.description) || "", requested = stamp(row.creation);
			return '<article class="fi-queue-row" role="listitem"><div class="fi-queue-head"><span class="fi-queue-icon">' + icon("lock") + '</span><div class="fi-queue-title"><strong>' + esc(row.tool_name) + "</strong>" + (requested ? '<span class="fi-queue-meta">Requested ' + esc(requested) + "</span>" : "") + '</div><span class="fi-pill">' + esc(row.status || "pending") + "</span></div>" + (target.doctype || target.name ? '<div class="fi-queue-target">' + icon("file") + "<span>" + esc(target.doctype || "") + (target.name ? '<span class="fi-context-divider">/</span>' + esc(target.name) : "") + "</span></div>" : "") + (summary ? '<p class="fi-queue-summary">' + esc(summary) + "</p>" : "") + (row.expires_at ? '<p class="fi-queue-expiry">Expires ' + esc(stamp(row.expires_at)) + "</p>" : "") + '<div class="fi-queue-actions">' + button("queue-open", "Open conversation", "chevron", "fi-text-btn", 'data-name="' + esc(row.conversation || "") + '"') + '<span class="fi-queue-spacer"></span>' + button("queue-deny", "Deny", null, "", 'data-name="' + esc(row.name) + '"') + button("queue-approve", "Approve", "check", "fi-primary", 'data-name="' + esc(row.name) + '"') + "</div></article>";
		}).join("") + "</div>";
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
	class Poller {
		constructor(task, schedule, clear) { this.task = task; this.schedule = schedule || global.setTimeout.bind(global); this.clear = clear || global.clearTimeout.bind(global); this.timer = null; this.running = false; this.generation = 0; }
		start(delay) { this.stop(); const generation = this.generation; this.timer = this.schedule(() => this.tick(generation), delay || 0); }
		async tick(generation) {
			this.timer = null; if (generation !== this.generation) return;
			if (this.running) { this.timer = this.schedule(() => this.tick(generation), 250); return; }
			this.running = true; let delay;
			try { delay = await this.task(); } finally { this.running = false; if (generation === this.generation && delay != null) this.timer = this.schedule(() => this.tick(generation), delay); }
		}
		stop() { this.generation++; if (this.timer !== null) this.clear(this.timer); this.timer = null; }
	}
	class App {
		constructor(options) {
			this.api = options && options.api || request; this.doc = options && options.document || global.document;
			this.boot = null; this.conversations = []; this.selected = null; this.snapshot = null; this.drafts = new Map(); this.watched = new Map(); this.pending = new Set(); this.inflight = new Map(); this.history = new Map();
			this.visible = false; this.archived = false; this.search = ""; this.provider = ""; this.context = null; this.loading = false; this.online = true; this.error = ""; this.notice = ""; this.selectVersion = 0; this.listVersion = 0; this.lastList = 0; this.failures = 0; this.messageSignature = "";
			this.poller = new Poller(() => this.poll()); this.root = this.doc.createElement("section"); this.root.className = "fi-app"; this.root.setAttribute("aria-label", "Intelligence workspace");
			this.root.innerHTML = this.shell(); this.bind(); this.render();
		}
		shell() { return '<aside class="fi-sidebar" aria-label="Private conversations">' + button("new", "New conversation", "plus", "fi-new") + '<label class="fi-search">' + icon("search") + '<input type="search" data-input="search" placeholder="Search conversations" aria-label="Search conversations" autocomplete="off"><kbd>⌘ K</kbd></label><div class="fi-sidebar-label"><span data-slot="list-label">Conversations</span>' + iconButton("archive-filter", "Show archived conversations", "archive", 'aria-pressed="false"') + '</div><nav class="fi-conversation-list" data-slot="conversations" aria-label="Conversation list"></nav><footer class="fi-sidebar-footer">' + button("approvals", "Approvals", "queue") + button("skills", "Skills", "grid") + button("memory", "Memory", "memory") + button("settings", "Providers & models", "settings") + button("scope", "Scope", "target") + '<div class="fi-private-note">' + icon("lock") + '<span>Only you can see your conversations</span></div></footer></aside><div class="fi-main"><header class="fi-header"><div class="fi-header-left">' + iconButton("sidebar", "Toggle conversations", "panel", 'aria-expanded="false"') + '<div class="fi-heading"><h2 data-slot="title">New conversation</h2><span data-slot="subtitle">Your private workspace</span></div></div><div class="fi-header-actions">' + iconButton("rename", "Rename conversation", "edit") + iconButton("archive", "Archive conversation", "archive") + iconButton("expand", "Open full workspace", "expand") + iconButton("close", "Close Intelligence", "close") + '</div></header><div class="fi-banner" data-slot="banner" role="status" hidden></div><div class="fi-thread" data-slot="thread" tabindex="0" aria-label="Messages"><div class="fi-thread-inner" data-slot="messages"></div></div><div class="fi-bottom"><div class="fi-run" data-slot="run" aria-live="polite" hidden></div><div class="fi-context-list" data-slot="context"></div><form class="fi-composer" aria-label="Message composer"><textarea data-input="message" rows="2" maxlength="100000" aria-label="Message Intelligence" placeholder="Ask a question, explore your data, or get something done…"></textarea><div class="fi-attachments" data-slot="attachments"></div><div class="fi-composer-toolbar"><div class="fi-composer-tools">' + iconButton("attach", "Attach a private PDF or text file", "attach") + '<label class="fi-provider-label"><span class="fi-provider-dot" aria-hidden="true"></span><select data-input="provider" aria-label="Provider and model"></select>' + icon("down") + '</label></div><button type="submit" class="fi-send" aria-label="Send message" title="Send message">' + icon("arrow") + '</button></div></form><div class="fi-composer-caption"><span>' + icon("lock") + ' You approve every tool action</span><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span></div></div></div>'; }
		$(selector) { return this.root.querySelector(selector); }
		slot(name) { return this.$('[data-slot="' + name + '"]'); }
		draft() { const key = this.selected || "new"; if (!this.drafts.has(key)) this.drafts.set(key, { text: "", attachments: [] }); return this.drafts.get(key); }
		isActive() { return !!(this.snapshot && this.snapshot.run && ACTIVE.has(this.snapshot.run.state)); }
		busy(key, work) {
			if (this.pending.has(key)) return Promise.resolve();
			this.pending.add(key); this.renderControls();
			return Promise.resolve().then(work).catch((error) => { this.error = userError(error); this.renderBanner(); }).finally(() => { this.pending.delete(key); this.renderControls(); });
		}
		bind() {
			this.root.addEventListener("click", (event) => { const target = event.target.closest("[data-action]"); if (target && this.root.contains(target) && !target.disabled) this.action(target.dataset.action, target); });
			this.root.addEventListener("input", (event) => {
				if (event.target.dataset.input === "message") { this.draft().text = event.target.value; this.resizeComposer(); this.renderControls(); }
				if (event.target.dataset.input === "search") { this.search = event.target.value; global.clearTimeout(this.searchTimer); this.searchTimer = global.setTimeout(() => this.refreshList().catch((error) => { this.error = userError(error); this.renderBanner(); }), 250); }
			});
			this.root.addEventListener("change", (event) => { if (event.target.dataset.input === "provider") this.provider = event.target.value; });
			this.$("form").addEventListener("submit", (event) => { event.preventDefault(); this.send(); });
			this.$("textarea").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); this.send(); } });
			this.root.addEventListener("keydown", (event) => { if (event.key === "Escape" && this.root.classList.contains("fi-sidebar-open")) { event.preventDefault(); event.stopPropagation(); this.root.classList.remove("fi-sidebar-open"); const toggle = this.$('[data-action="sidebar"]'); toggle.setAttribute("aria-expanded", "false"); toggle.focus(); } });
		}
		async init() {
			if (this.initializing) return this.initializing;
			this.initializing = (async () => {
				try { this.loading = true; this.render(); this.boot = await this.api("bootstrap"); if (!this.boot || !this.boot.enabled) { this.error = "Intelligence is disabled on this site. Contact your system manager."; return; }
					this.provider = this.provider || this.boot.defaults && this.boot.defaults.provider || this.boot.providers && this.boot.providers[0] && this.boot.providers[0].name || "";
					await this.refreshList(); this.error = "";
				} catch (error) { this.error = userError(error); } finally { this.loading = false; this.render(); this.poller.start(0); this.initializing = null; }
			})(); return this.initializing;
		}
		show(host, mode) {
			this.visible = true; this.mode = mode || "page"; this.root.classList.toggle("fi-drawer-app", this.mode === "drawer"); host.appendChild(this.root); this.render();
			if (!this.boot) this.init(); else this.poller.start(0);
		}
		hide() { this.visible = false; this.root.classList.remove("fi-sidebar-open"); global.clearTimeout(this.searchTimer); this.poller.stop(); if (this.watched.size) this.poller.start(1000); }
		async refreshList() {
			const version = ++this.listVersion;
			const list = await this.api("list_conversations", { search: this.search, archived: this.archived ? 1 : 0 });
			if (version !== this.listVersion) return;
			this.conversations = Array.isArray(list) ? list : []; this.lastList = Date.now();
			for (const row of this.conversations) if (row.active_run && !this.watched.has(row.name)) this.watched.set(row.name, { name: typeof row.active_run === "object" ? row.active_run.name : row.active_run, state: "running" });
			this.renderSidebar();
		}
		async fetchConversation(name) {
			if (this.inflight.has(name)) return this.inflight.get(name);
			const promise = this.api("get_conversation", { conversation: name }).finally(() => this.inflight.delete(name)); this.inflight.set(name, promise); return promise;
		}
		async select(name) {
			if (this.pending.has("send") || this.pending.has("upload")) return;
			const version = ++this.selectVersion; this.selected = name; this.snapshot = null; this.error = ""; this.notice = ""; this.messageSignature = ""; this.loadingConversation = true; this.root.classList.remove("fi-sidebar-open"); this.render(); this.syncDraft();
			try { const data = await this.fetchConversation(name); if (version !== this.selectVersion) return; this.accept(name, data); }
			catch (error) { if (version === this.selectVersion) this.error = userError(error); }
			finally { if (version === this.selectVersion) { this.loadingConversation = false; this.render(); this.poller.start(0); } }
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
		render() { this.renderSidebar(); this.renderHeader(); this.renderMessages(); this.renderRun(); this.renderContext(); this.renderAttachments(); this.renderProviders(); this.renderControls(); this.renderBanner(); }
		renderHeader() {
			this.slot("title").textContent = this.snapshot && this.snapshot.conversation.title || (this.selected ? "Conversation" : "New conversation");
			this.slot("subtitle").textContent = this.snapshot && this.snapshot.conversation.archived ? "Archived · read only" : "Private · only you";
			for (const action of ["rename", "archive"]) this.$('[data-action="' + action + '"]').hidden = !this.selected;
			this.$('[data-action="expand"]').hidden = this.mode !== "drawer"; this.$('[data-action="close"]').hidden = this.mode !== "drawer";
			const archive = this.$('[data-action="archive"]'); const archived = !!(this.snapshot && this.snapshot.conversation.archived); archive.setAttribute("aria-label", archived ? "Restore conversation" : "Archive conversation"); archive.title = archived ? "Restore conversation" : "Archive conversation";
		}
		renderSidebar() {
			const signature = JSON.stringify([this.conversations, this.selected, this.archived, this.loading, this.search]);
			if (signature === this.sidebarSignature) return; this.sidebarSignature = signature;
			this.slot("list-label").textContent = this.archived ? "Archived conversations" : "Conversations";
			const filter = this.$('[data-action="archive-filter"]'); filter.setAttribute("aria-pressed", String(this.archived)); filter.title = this.archived ? "Show active conversations" : "Show archived conversations";
			this.slot("conversations").innerHTML = this.conversations.length ? this.conversations.map((row) => '<button type="button" class="fi-conversation ' + (this.selected === row.name ? "is-active" : "") + '" data-action="select" data-name="' + esc(row.name) + '" ' + (this.selected === row.name ? 'aria-current="true"' : "") + '><span class="fi-conversation-icon">' + icon("chat") + '</span><span class="fi-conversation-info"><span class="fi-conversation-title">' + esc(row.title || "Untitled conversation") + '</span><span class="fi-conversation-meta">' + esc(time(row.modified)) + (row.active_run ? '<span class="fi-list-status">In progress</span>' : "") + '</span></span>' + (row.active_run ? '<span class="fi-status-dot" aria-label="Active run"></span>' : "") + '</button>').join("") : '<div class="fi-list-empty">' + (this.loading ? "Loading conversations…" : this.search ? "No conversations match your search." : this.archived ? "No archived conversations." : "Your conversations will appear here.") + '</div>';
		}
		renderProviders() {
			const select = this.$('[data-input="provider"]'); const providers = this.boot && this.boot.providers || [];
			let options = providers.map((provider) => '<option value="' + esc(provider.name) + '">' + esc(provider.title + " · " + provider.model) + '</option>').join("");
			if (this.selected && !providers.some((provider) => provider.name === this.provider)) options += '<option value="' + esc(this.provider) + '">Provider unavailable</option>';
			if (select.dataset.options !== options) { select.innerHTML = options || '<option value="">Set up a provider</option>'; select.dataset.options = options; }
			select.value = this.provider;
			select.title = this.selected ? "This conversation uses its original provider. Start a new conversation to switch." : "Choose a configured provider and model";
		}
		renderBanner() {
			const banner = this.slot("banner"); const message = this.error || (!this.online ? "Connection interrupted. Reconnecting automatically; your run continues on the server." : this.notice);
			const signature = JSON.stringify([message, !!this.error]); if (signature === this.bannerSignature) return; this.bannerSignature = signature;
			banner.hidden = !message; banner.classList.toggle("is-error", !!this.error); banner.setAttribute("role", this.error ? "alert" : "status");
			banner.innerHTML = message ? icon(this.error ? "info" : "retry") + '<span>' + esc(message) + '</span>' + button("refresh", "Refresh", null, "fi-text-btn") + iconButton("dismiss", "Dismiss notification", "close") : "";
		}
		renderMessages() {
			const slot = this.slot("messages"), thread = this.slot("thread");
			const signature = JSON.stringify([this.loading, this.loadingConversation, this.selected, this.snapshot && this.snapshot.messages, this.snapshot && this.snapshot.approvals, this.snapshot && this.snapshot.has_earlier_messages, this.boot && this.boot.providers]);
			if (signature === this.messageSignature) return; this.messageSignature = signature;
			const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
			if (this.loading || this.loadingConversation) { slot.innerHTML = '<div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading your workspace…</div>'; return; }
			const messages = this.snapshot && this.snapshot.messages || [];
			const approvals = this.snapshot && this.snapshot.approvals || [];
			if (!messages.length && !approvals.length) {
				const noProviders = this.boot && !(this.boot.providers || []).length;
				slot.innerHTML = '<div class="fi-welcome"><div class="fi-welcome-symbol" aria-hidden="true"><span class="fi-mark"><i></i><i></i><i></i><i></i></span></div><h2>How can I help?</h2><p>Ask about your business. Find the right records.<br>Take the next step, with you in control.</p>' + (noProviders ? '<div class="fi-setup-note"><strong>Connect a provider to get started</strong><p>Use your own API key and choose the model that works for you.</p>' + button("settings", "Set up a provider", "plus", "fi-primary") + '</div>' : '<div class="fi-starters"><button type="button" data-action="starter" data-prompt="Help me find the records I need to review today."><span class="fi-starter-icon">' + icon("search") + '</span><strong>Find what matters</strong><span>Explore records you can access</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Help me understand this workflow before making any changes."><span class="fi-starter-icon">' + icon("chat") + '</span><strong>Think it through</strong><span>Understand a process or next step</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Review an attached document and help me identify the next steps."><span class="fi-starter-icon">' + icon("file") + '</span><strong>Start with a document</strong><span>Work with a private PDF or text file</span>' + icon("chevron") + '</button></div>') + '<div class="fi-welcome-foot">' + icon("lock") + ' Private conversations. Explicit approvals. Your permissions.</div></div>';
			} else {
				slot.innerHTML = (this.snapshot.has_earlier_messages ? '<div class="fi-history-more">' + button("earlier", "Load earlier messages", "retry", "fi-text-btn") + '</div>' : '') + '<div class="fi-thread-start">' + icon("lock") + ' This conversation is private to you</div>' + messages.filter((message) => ["user", "assistant"].includes(message.role) && message.content).map((message) => '<article class="fi-message fi-message-' + esc(message.role) + '" data-message="' + esc(message.name) + '"><div class="fi-message-heading"><span class="fi-avatar ' + (message.role === "assistant" ? "fi-avatar-ai" : "") + '">' + (message.role === "assistant" ? '<span class="fi-mark"><i></i><i></i><i></i><i></i></span>' : "Y") + '</span><strong>' + (message.role === "assistant" ? "Intelligence" : "You") + '</strong><span>' + esc(time(message.creation)) + '</span>' + (message.status === "interrupted" ? '<span class="fi-message-interrupted">Interrupted</span>' : "") + '</div><div class="fi-message-content">' + markdown(message.content) + '</div></article>').join("") + approvals.map((approval) => this.approvalHTML(approval)).join("");
			}
			if (nearBottom || !this.snapshot || this.snapshot.messages && this.snapshot.messages.length < 2) thread.scrollTop = thread.scrollHeight;
		}
		approvalHTML(approval) {
			const pending = approval.status === "pending", locked = this.pending.has("approval:" + approval.name);
			return '<section class="fi-approval ' + (pending ? "is-pending" : "") + '" aria-label="Tool approval"><div class="fi-approval-top"><span class="fi-approval-icon">' + icon(pending ? "lock" : "check") + '</span><div><span class="fi-eyebrow">' + (pending ? "YOUR APPROVAL IS REQUIRED" : "TOOL ACTION") + '</span><h3>' + esc(approval.tool_name) + '</h3></div><span class="fi-pill">' + esc(approval.status) + '</span></div>' + previewHTML(approval.preview) + (approval.expires_at && pending ? '<p class="fi-approval-expiry">Expires ' + esc(approval.expires_at) + '</p>' : "") + (pending ? '<div class="fi-approval-footer"><span>Nothing runs until you approve.</span><div>' + button("deny", "Deny", null, "", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + button("approve", "Approve action", "check", "fi-primary", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + '</div></div>' : '<div class="fi-approval-result">' + esc({ approved: "Approved; waiting for execution.", denied: "Denied. This request will not run.", executing: "Executing the approved request.", succeeded: "The approved action completed.", failed: "The action failed. Check the run status.", expired: "This approval expired. Start a new request if it is still needed.", uncertain: "The result could not be confirmed. Check the record before trying again." }[approval.status] || "") + '</div>') + '</section>';
		}
		renderRun() {
			const run = this.snapshot && this.snapshot.run, slot = this.slot("run"); slot.hidden = !run;
			const signature = JSON.stringify([run, this.pending.has("cancel")]); if (signature === this.runSignature) return; this.runSignature = signature;
			if (!run) return;
			const active = ACTIVE.has(run.state), warning = ["failed", "needs_reconciliation"].includes(run.state);
			slot.classList.toggle("is-warning", warning);
			slot.innerHTML = '<span class="' + (active && run.state !== "awaiting_approval" ? "fi-spinner" : "fi-run-icon") + '">' + (active && run.state !== "awaiting_approval" ? "" : icon(warning ? "info" : run.state === "awaiting_approval" ? "lock" : "check")) + '</span><div class="fi-run-copy"><strong>' + esc(LABELS[run.state] || run.state) + '</strong><span>' + esc(run.error || (run.cancel_requested ? "Cancellation requested. An action already in progress may finish." : run.state === "awaiting_approval" ? "You can leave and return. This request is waiting for your decision." : active ? "You can leave this page. Your run is saved and continues in the background." : run.state === "cancelled" ? "Any previously completed actions are not reversed." : run.state === "needs_reconciliation" ? "Check the affected records before trying again." : "This run is saved with your conversation.")) + '</span></div>' + (active ? button("cancel", run.cancel_requested ? "Stopping…" : "Stop", "stop", "fi-text-btn", run.cancel_requested || this.pending.has("cancel") ? "disabled" : "") : "");
		}
		renderContext() {
			const context = this.context;
			const signature = JSON.stringify(context); if (signature === this.contextSignature) return; this.contextSignature = signature;
			this.slot("context").innerHTML = context ? '<span class="fi-context-caption">Context for your next message</span><span class="fi-context-chip">' + icon("file") + '<span>' + esc(context.doctype) + (context.name ? '<span class="fi-context-divider">/</span>' + esc(context.name) : "") + '</span>' + iconButton("remove-context", "Remove page context", "close") + '</span>' : "";
		}
		renderAttachments() {
			const files = this.snapshot && this.snapshot.files || [];
			const signature = JSON.stringify([this.draft().attachments, files, this.pending.has("upload")]); if (signature === this.attachmentSignature) return; this.attachmentSignature = signature;
			this.slot("attachments").innerHTML = this.draft().attachments.map((file) => '<span class="fi-file-chip">' + icon("file") + '<span>' + esc(file.file_name) + '</span>' + iconButton("remove-file", "Remove " + file.file_name + " from this message", "close", 'data-name="' + esc(file.name) + '"') + '</span>').join("") + (this.pending.has("upload") ? '<span class="fi-file-chip"><span class="fi-spinner"></span>Uploading privately…</span>' : "") + (files.length ? button("files", files.length + " saved " + (files.length === 1 ? "file" : "files"), "attach", "fi-text-btn fi-saved-files") : "");
		}
		renderControls() {
			const busy = this.pending.has("send") || this.pending.has("upload"), archived = !!(this.snapshot && this.snapshot.conversation.archived);
			const unavailable = !this.boot || !this.boot.enabled || this.loading || this.loadingConversation;
			const providerAvailable = !!(this.boot && (this.boot.providers || []).some((provider) => provider.name === this.provider));
			const cancel = this.$('[data-action="cancel"]'); if (cancel) cancel.disabled = this.pending.has("cancel") || !!(this.snapshot && this.snapshot.run && this.snapshot.run.cancel_requested);
			this.$("textarea").disabled = !!(unavailable || archived || this.pending.has("send"));
			this.$(".fi-send").disabled = !!(unavailable || busy || archived || this.isActive() || !providerAvailable || !this.draft().text.trim());
			this.$(".fi-send").setAttribute("aria-label", this.pending.has("send") ? "Sending message" : this.isActive() ? "Wait for this run to finish" : "Send message");
			this.$('[data-action="attach"]').disabled = !!(unavailable || busy || archived || this.isActive() || !providerAvailable || this.boot && this.boot.capabilities && this.boot.capabilities.attachments === false);
			this.$('[data-input="provider"]').disabled = !!(unavailable || busy || this.selected);
			for (const action of ["new", "archive", "rename"]) this.$('[data-action="' + action + '"]').disabled = !!(unavailable || busy || this.pending.has(action));
			for (const element of this.root.querySelectorAll('[data-action="select"]')) element.disabled = busy;
			for (const element of this.root.querySelectorAll('[data-action="approve"], [data-action="deny"]')) element.disabled = this.pending.has("approval:" + element.dataset.name);
			for (const element of this.root.querySelectorAll('[data-action="remove-file"], [data-action="remove-context"]')) element.disabled = this.pending.has("send");
			const earlier = this.$('[data-action="earlier"]'); if (earlier) earlier.disabled = this.pending.has("earlier");
			this.root.setAttribute("aria-busy", String(!!this.loading));
		}
		syncDraft() { this.$("textarea").value = this.draft().text; this.resizeComposer(); this.renderAttachments(); this.renderControls(); }
		resizeComposer() { const input = this.$("textarea"); input.style.height = "auto"; input.style.height = Math.min(180, Math.max(64, input.scrollHeight)) + "px"; }
		async ensureConversation() {
			if (this.selected) return this.selected;
			const draft = this.draft(); const conversation = await this.api("create_conversation", { provider: this.provider });
			if (!conversation || !conversation.name) throw { userMessage: "The server did not return a conversation. Refresh before trying again." };
			this.selected = conversation.name; this.selectVersion++; this.drafts.set(conversation.name, draft); this.drafts.delete("new"); this.snapshot = { conversation, messages: [], approvals: [], files: [], run: null }; this.lastList = 0; this.render(); return conversation.name;
		}
		send() {
			if (this.$(".fi-send").disabled || this.pending.has("send")) return Promise.resolve();
			return this.busy("send", async () => {
				this.error = ""; const draft = this.draft(), content = draft.text.trim(), attachments = draft.attachments.map((file) => file.name), context = this.context ? Object.assign({}, this.context) : null;
				const name = await this.ensureConversation();
				try { const run = await this.api("send_message", { conversation: name, content, context: context ? JSON.stringify(context) : null, attachments: JSON.stringify(attachments) });
					if (!run || !run.name) throw { userMessage: "No run was returned. Refresh before trying again; your message may have been saved." };
					draft.text = ""; draft.attachments = []; this.watched.set(name, run); this.snapshot.run = run; this.syncDraft(); this.renderRun(); this.poller.start(0);
					const data = await this.fetchConversation(name); this.accept(name, data); this.lastList = 0;
				} catch (error) { this.poller.start(0); throw error; }
			});
		}
		action(action, target) {
			if (action === "select") return this.select(target.dataset.name);
			if (action === "new") { if (this.pending.has("send") || this.pending.has("upload")) return; this.selectVersion++; this.selected = null; this.snapshot = null; this.loadingConversation = false; this.error = ""; this.notice = ""; this.root.classList.remove("fi-sidebar-open"); this.render(); this.syncDraft(); this.$("textarea").focus(); return; }
			if (action === "sidebar") { const open = this.root.classList.toggle("fi-sidebar-open"); target.setAttribute("aria-expanded", String(open)); if (open) this.$('[data-input="search"]').focus(); return; }
			if (action === "archive-filter") { this.archived = !this.archived; this.refreshList().catch((error) => { this.error = userError(error); this.renderBanner(); }); return; }
			if (action === "starter") { this.draft().text = target.dataset.prompt; this.syncDraft(); this.$("textarea").focus(); return; }
			if (action === "remove-context") { this.context = null; this.renderContext(); return; }
			if (action === "remove-file") { this.draft().attachments = this.draft().attachments.filter((file) => file.name !== target.dataset.name); this.renderAttachments(); return; }
			if (action === "dismiss") { this.error = ""; this.notice = ""; this.renderBanner(); return; }
			if (action === "refresh") return this.refresh();
			if (action === "earlier") return this.loadEarlier();
			if (action === "close") return this.onClose && this.onClose();
			if (action === "expand") return this.onExpand && this.onExpand();
			if (action === "settings") return this.providerDialog();
			if (action === "memory") return this.memoryDialog();
			if (action === "skills") return this.skillsDialog();
			if (action === "approvals") return this.approvalsDialog();
			if (action === "scope") return this.scopeDialog();
			if (action === "rename") return this.renameDialog();
			if (action === "archive") return this.archiveDialog();
			if (action === "attach") return this.chooseFile();
			if (action === "files") return this.filesDialog();
			if (action === "copy-code") { const text = target.closest(".fi-code").querySelector("code").textContent; if (!global.navigator || !global.navigator.clipboard) { this.error = "Clipboard access is unavailable. Select and copy the code directly."; this.renderBanner(); return; } return global.navigator.clipboard.writeText(text).then(() => { target.textContent = "Copied"; global.setTimeout(() => { target.textContent = "Copy"; }, 1800); }).catch(() => { this.error = "Could not copy. Select and copy the code directly."; this.renderBanner(); }); }
			if (action === "cancel") return this.busy("cancel", async () => { const name = this.selected; await this.api("cancel", { run: this.snapshot.run.name }); this.accept(name, await this.fetchConversation(name)); this.poller.start(0); });
			if (["approve", "deny"].includes(action)) { const name = this.selected; return this.busy("approval:" + target.dataset.name, async () => { await this.api("approve", { approval: target.dataset.name, decision: action }); this.accept(name, await this.fetchConversation(name)); this.poller.start(0); }); }
		}
		dialog(title, body, options) {
			if (this.modal) this.modal.close();
			const previous = this.doc.activeElement, overlay = this.doc.createElement("div"); overlay.className = "fi-modal-overlay";
			overlay.innerHTML = '<section class="fi-modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><header><div><h2>' + esc(title) + '</h2></div>' + iconButton("modal-close", "Close dialog", "close") + '</header><div class="fi-modal-body">' + body + '</div><div class="fi-modal-error" role="alert" hidden></div></section>';
			this.doc.body.appendChild(overlay);
			const modal = { element: overlay, busy: false, closed: false, close: () => { if (modal.busy) return; modal.closed = true; overlay.remove(); if (this.modal === modal) this.modal = null; if (previous && previous.isConnected) previous.focus(); }, error: (error) => { const node = overlay.querySelector(".fi-modal-error"); node.hidden = false; node.textContent = userError(error); }, run: async (work) => { if (modal.busy || modal.closed) return; modal.busy = true; const focused = this.doc.activeElement, controls = Array.from(overlay.querySelectorAll("button, input, select, textarea")); const disabled = controls.map((node) => node.disabled); controls.forEach((node) => { node.disabled = true; }); overlay.querySelector(".fi-modal-error").hidden = true; try { await work(); } catch (error) { modal.error(error); } finally { modal.busy = false; controls.forEach((node, index) => { node.disabled = disabled[index]; }); if (!modal.closed && !overlay.contains(this.doc.activeElement)) { const next = focused && focused.isConnected && !focused.disabled ? focused : overlay.querySelector("input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])"); if (next) next.focus(); } } } };
			this.modal = modal;
			overlay.addEventListener("click", (event) => { if (event.target === overlay || event.target.closest('[data-action="modal-close"]')) modal.close(); });
			overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); modal.close(); } if (event.key === "Tab") trapFocus(event, overlay); });
			global.setTimeout(() => { if (!modal.closed) { const first = overlay.querySelector(options && options.focus || "input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])"); if (first) first.focus(); } }, 0);
			return modal;
		}
		renameDialog() {
			if (!this.snapshot) return; const name = this.selected;
			const modal = this.dialog("Rename conversation", '<form data-form="rename"><label class="fi-field control-label">Conversation title<input class="form-control" name="title" maxlength="140" required value="' + esc(this.snapshot.conversation.title) + '"></label><footer>' + button("modal-close", "Cancel") + '<button class="btn btn-primary btn-sm fi-btn fi-primary" type="submit">Save title</button></footer></form>');
			modal.element.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); const title = event.target.elements.title.value.trim(); if (!title) return; modal.run(async () => { await this.api("rename_conversation", { conversation: name, title }); if (this.selected === name) this.snapshot.conversation.title = title; await this.refreshList(); this.renderHeader(); modal.busy = false; modal.close(); }); });
		}
		archiveDialog() {
			if (!this.snapshot) return; const name = this.selected, restore = !!this.snapshot.conversation.archived;
			const modal = this.dialog(restore ? "Restore this conversation?" : "Archive this conversation?", '<p class="fi-dialog-copy">' + (restore ? "Move this conversation back to your active list." : "Your messages and approvals will remain saved. Archiving does not cancel a running task.") + '</p><footer>' + button("modal-close", "Keep it here") + button("confirm-archive", restore ? "Restore conversation" : "Archive conversation", "archive", "fi-primary") + '</footer>');
			modal.element.querySelector('[data-action="confirm-archive"]').addEventListener("click", () => modal.run(async () => { await this.api("archive_conversation", { conversation: name, archived: restore ? 0 : 1 }); this.accept(name, await this.fetchConversation(name)); await this.refreshList(); modal.busy = false; modal.close(); }));
		}
		filesDialog() {
			const files = this.snapshot && this.snapshot.files || [], name = this.selected;
			const readOnly = this.pending.has("send") || this.pending.has("upload") || this.isActive() || !!(this.snapshot && Number(this.snapshot.conversation.archived));
			const selected = new Set(this.draft().attachments.map((file) => file.name));
			const modal = this.dialog("Conversation files", '<p class="fi-dialog-copy">Files stay private to this conversation. Add a file to your next message to reference it. Reading its contents still requires your approval.</p><div class="fi-saved-file-list">' + files.map((file) => {
				const url = safeURL(file.file_url), link = url && url.startsWith("/private/files/") ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open file</a>' : '';
				return '<div class="fi-saved-file-row">' + icon("file") + '<div><strong>' + esc(file.file_name) + '</strong>' + link + '</div>' + button("reuse-file", selected.has(file.name) ? "Added" : "Add to message", "plus", "", 'data-name="' + esc(file.name) + '" ' + (readOnly || selected.has(file.name) ? "disabled" : "")) + '</div>';
			}).join("") + '</div>');
			modal.element.addEventListener("click", (event) => { const target = event.target.closest('[data-action="reuse-file"]'); if (!target || target.disabled || this.selected !== name || this.pending.has("send")) return; const file = files.find((entry) => entry.name === target.dataset.name); if (!file || this.draft().attachments.some((entry) => entry.name === file.name)) return; this.draft().attachments.push(file); this.renderAttachments(); target.disabled = true; target.querySelector("span").textContent = "Added"; });
		}
		chooseFile() {
			const input = this.doc.createElement("input"); input.type = "file"; input.accept = ".pdf,.txt,.csv,.md,.json,text/plain,text/csv,application/pdf";
			input.addEventListener("change", () => { const file = input.files && input.files[0]; if (file) this.upload(file); }); input.click();
		}
		upload(file) {
			if (this.pending.has("upload") || this.pending.has("send") || this.isActive()) return Promise.resolve();
			const max = Number(this.boot && this.boot.defaults && this.boot.defaults.max_upload_mb) || 10;
			if (!/\.(pdf|txt|csv|md|json)$/i.test(file.name) || file.size > max * 1024 * 1024) { this.error = "Choose a PDF or text file up to " + max + " MB."; this.renderBanner(); return Promise.resolve(); }
			return this.busy("upload", async () => {
				this.renderAttachments(); const name = await this.ensureConversation(), form = new global.FormData(); form.append("file", file); form.append("conversation", name);
				const abort = new global.AbortController(), timer = global.setTimeout(() => abort.abort(), 60000); let response, data;
				try {
					response = await global.fetch("/api/method/" + API + "upload_attachment", { method: "POST", body: form, credentials: "same-origin", signal: abort.signal, headers: { "X-Frappe-CSRF-Token": global.frappe.csrf_token || "" } });
					try { data = await response.json(); } catch (_) { throw { status: response.status }; }
				} catch (error) { if (error.name === "AbortError") throw { userMessage: "The upload timed out. The file may have been saved privately, but it was not added to this message. Refresh before uploading again." }; throw error; }
				finally { global.clearTimeout(timer); }
				if (!response.ok || data.exc) throw Object.assign({ status: response.status }, data);
				const attachment = data.message;
				if (!attachment || !attachment.name || !Number(attachment.is_private)) throw { userMessage: "The server did not confirm a private attachment. It was not added to your message." };
				this.draft().attachments.push(attachment); this.notice = "File uploaded privately. Its contents are only read after you approve a tool request."; this.renderBanner();
			}).finally(() => this.renderAttachments());
		}
		providerDialog() {
			if (!this.boot) return;
			const providers = this.boot.managed_providers || this.boot.providers || [], modal = this.dialog("Providers & models", '<p class="fi-dialog-copy">Bring your own provider. Credentials stay on the server and are never shown here.</p><div class="fi-provider-settings"><nav class="fi-provider-list" aria-label="Configured providers">' + providers.map((provider) => '<button type="button" data-provider="' + esc(provider.name) + '"><strong>' + esc(provider.title) + '</strong><span>' + esc(provider.kind + " · " + provider.model) + '</span></button>').join("") + '<button type="button" data-provider="">' + icon("plus") + ' Add provider</button></nav><form class="fi-provider-form"><h3 data-provider-heading>Add a provider</h3><input type="hidden" name="name"><label class="fi-field control-label">Name<input class="form-control" name="title" required maxlength="140" placeholder="My work provider" autocomplete="off"></label><div class="fi-field-row"><label class="fi-field control-label">Provider<select class="form-control" name="kind">' + KINDS.map((kind) => '<option>' + esc(kind) + '</option>').join("") + '</select></label><label class="fi-field control-label">Model ID<input class="form-control" name="model" required maxlength="140" placeholder="Enter your provider’s model ID" autocomplete="off"></label></div><label class="fi-field control-label">API key<input class="form-control" name="api_key" type="password" autocomplete="new-password" placeholder="Enter API key"><span>Leave blank when editing to keep the saved key.</span></label><label class="fi-field" data-base-url hidden>Custom endpoint URL<input class="form-control" name="base_url" type="url" placeholder="https://api.example.com/v1" autocomplete="off"><span>HTTPS only. The hostname must be allowlisted by your administrator.</span></label><div class="fi-checkbox-row"><label><input type="checkbox" name="enabled" checked> Enabled</label>' + (this.boot.is_manager ? '<label><input type="checkbox" name="is_shared"> Shared with this site</label>' : '') + '</div><label class="fi-field" data-allowed-roles hidden>Allowed roles<textarea class="form-control" name="allowed_roles" rows="2" placeholder="One Frappe role per line"></textarea><span>For shared providers. Leave blank to allow all authorized Intelligence users.</span></label><div class="fi-field-row"><label class="fi-field control-label">Output token limit<input class="form-control" name="max_tokens" type="number" min="128" max="32768" value="4096" required></label><label class="fi-field control-label">Timeout (seconds)<input class="form-control" name="timeout" type="number" min="5" max="120" value="60" required></label></div><p class="fi-field-help" data-provider-note>Saving stores this configuration; it does not test a paid provider request.</p><footer><button type="button" class="fi-btn fi-danger" data-delete-provider hidden>Delete provider</button><button type="submit" class="btn btn-primary btn-sm fi-btn fi-primary">Save provider</button></footer></form></div>');
			const form = modal.element.querySelector("form"), fields = form.elements;
			const kindChanged = () => { form.querySelector('[data-base-url]').hidden = fields.kind.value !== "Custom"; fields.base_url.required = fields.kind.value === "Custom"; };
			fields.kind.addEventListener("change", kindChanged);
			const sharedChanged = () => { form.querySelector('[data-allowed-roles]').hidden = !(fields.is_shared && fields.is_shared.checked); };
			if (fields.is_shared) fields.is_shared.addEventListener("change", sharedChanged);
			let loadVersion = 0;
			const load = async (name) => { const version = ++loadVersion; await modal.run(async () => { const data = name ? await this.api("provider_details", { name }) : {}; if (version !== loadVersion || modal.closed) return; form.reset(); fields.name.value = data.name || ""; fields.title.value = data.title || ""; fields.kind.value = data.kind || "OpenAI"; fields.model.value = data.model || ""; fields.base_url.value = data.base_url || ""; fields.api_key.value = ""; fields.allowed_roles.value = data.allowed_roles || ""; fields.max_tokens.value = data.max_tokens || 4096; fields.timeout.value = data.timeout || 60; fields.enabled.checked = name ? !!Number(data.enabled) : true; if (fields.is_shared) fields.is_shared.checked = !!Number(data.is_shared); form.querySelector('[data-provider-heading]').textContent = name ? "Edit provider" : "Add a provider"; form.querySelector('[data-delete-provider]').hidden = !name; form.querySelector('[data-delete-provider]').dataset.confirm = ""; form.querySelector('[data-delete-provider]').textContent = "Delete provider"; kindChanged(); sharedChanged(); const readOnly = data.can_edit === false || !!(Number(data.is_shared) && !this.boot.is_manager); form.dataset.readOnly = String(readOnly); form.querySelector('[data-provider-note]').textContent = readOnly ? "You cannot edit this provider. Ask its owner or your system manager." : name ? "For a provider used by an existing conversation, create a new configuration to change its kind, model, or endpoint. Blank API key preserves the saved key." : "Saving stores this configuration; it does not test a paid provider request."; }); if (!modal.closed) for (const node of form.querySelectorAll("input,select,button")) node.disabled = form.dataset.readOnly === "true"; };
			modal.element.querySelectorAll("[data-provider]").forEach((element) => element.addEventListener("click", () => load(element.dataset.provider)));
			form.addEventListener("submit", (event) => { event.preventDefault(); if (form.dataset.readOnly === "true") return; const values = { name: fields.name.value || null, title: fields.title.value.trim(), kind: fields.kind.value, model: fields.model.value.trim(), api_key: fields.api_key.value || null, base_url: fields.kind.value === "Custom" ? fields.base_url.value.trim() : "", enabled: fields.enabled.checked ? 1 : 0, is_shared: fields.is_shared && fields.is_shared.checked ? 1 : 0, allowed_roles: fields.allowed_roles.value, max_tokens: Number(fields.max_tokens.value), timeout: Number(fields.timeout.value) }; modal.run(async () => { await this.api("save_provider", values); fields.api_key.value = ""; this.boot = await this.api("bootstrap"); if (!this.selected && !(this.boot.providers || []).some((provider) => provider.name === this.provider)) this.provider = this.boot.providers[0] && this.boot.providers[0].name || ""; this.render(); modal.busy = false; modal.close(); this.notice = "Provider saved."; this.renderBanner(); }); });
			form.querySelector('[data-delete-provider]').addEventListener("click", () => { if (!fields.name.value || form.dataset.readOnly === "true") return; const element = form.querySelector('[data-delete-provider]'); if (element.dataset.confirm !== fields.name.value) { element.dataset.confirm = fields.name.value; element.textContent = "Confirm delete"; return; } modal.run(async () => { await this.api("delete_provider", { name: fields.name.value }); this.boot = await this.api("bootstrap"); this.provider = this.selected ? this.provider : this.boot.providers[0] && this.boot.providers[0].name || ""; this.render(); modal.busy = false; modal.close(); this.notice = "Provider deleted."; this.renderBanner(); }); });
		}
		memoryDialog() {
			if (!this.boot) return; const conversation = this.selected;
			const modal = this.dialog("Memory", '<p class="fi-dialog-copy">Keep useful preferences and context. Memories are only read by the assistant after you approve a recall request.</p><label class="fi-field control-label">Scope<select class="form-control" data-memory-scope><option value="personal">Personal · only you</option>' + (conversation ? '<option value="conversation">This conversation</option>' : '') + '<option value="site">Site · shared with all users</option></select></label><div class="fi-memory-list" data-memory-list role="list"></div><form class="fi-memory-form"><input type="hidden" name="name"><label class="fi-field control-label"><span data-memory-heading>Add a memory</span><textarea class="form-control" name="content" rows="4" maxlength="5000" required placeholder="For example: use our fiscal year when comparing reports."></textarea></label><p class="fi-field-help" data-memory-help>Never store passwords, API keys, or other secrets in memory.</p><footer><button type="button" class="fi-btn" data-memory-reset>Clear editor</button><button type="submit" class="btn btn-primary btn-sm fi-btn fi-primary">Save memory</button></footer></form>');
			const scope = modal.element.querySelector('[data-memory-scope]'), list = modal.element.querySelector('[data-memory-list]'), form = modal.element.querySelector("form"); let memories = [];
			const reset = () => { form.reset(); form.elements.name.value = ""; form.querySelector('[data-memory-heading]').textContent = "Add a memory"; };
			const refresh = async () => { list.innerHTML = '<div class="fi-list-empty">Loading memories…</div>'; memories = await this.api("list_memories", { scope: scope.value, conversation: scope.value === "conversation" ? conversation : null }); if (modal.closed) return; const readOnly = scope.value === "site" && !this.boot.is_manager; form.hidden = readOnly; list.innerHTML = (Array.isArray(memories) && memories.length ? memories.map((memory) => '<article class="fi-memory-item" role="listitem"><p>' + esc(memory.content) + '</p>' + (!readOnly ? '<div>' + button("memory-edit", "Edit", "edit", "fi-text-btn", 'data-name="' + esc(memory.name) + '"') + button("memory-delete", "Delete", null, "fi-text-btn fi-danger", 'data-name="' + esc(memory.name) + '"') + '</div>' : '') + '</article>').join("") : '<div class="fi-memory-empty">' + icon("memory") + '<strong>No memories in this scope</strong><span>' + (readOnly ? "Site memories are managed by your administrator." : "Save a useful preference to make future work more consistent.") + '</span></div>'); };
			scope.addEventListener("change", () => { reset(); modal.run(refresh); });
			modal.element.querySelector('[data-memory-reset]').addEventListener("click", reset);
			list.addEventListener("click", (event) => { const target = event.target.closest('[data-action]'); if (!target || modal.busy) return; const memory = memories.find((entry) => entry.name === target.dataset.name); if (!memory) return; if (target.dataset.action === "memory-edit") { form.elements.name.value = memory.name; form.elements.content.value = memory.content; form.querySelector('[data-memory-heading]').textContent = "Edit memory"; form.elements.content.focus(); } else if (target.dataset.action === "memory-delete") { if (target.dataset.confirm !== "yes") { target.dataset.confirm = "yes"; target.querySelector("span").textContent = "Confirm delete"; return; } modal.run(async () => { await this.api("delete_memory", { name: memory.name }); if (form.elements.name.value === memory.name) reset(); await refresh(); }); } });
			form.addEventListener("submit", (event) => { event.preventDefault(); const content = form.elements.content.value.trim(); if (!content) return; const values = { name: form.elements.name.value || null, content, scope: scope.value, conversation: scope.value === "conversation" ? conversation : null }; modal.run(async () => { await this.api("save_memory", values); reset(); await refresh(); }); }); modal.run(refresh);
		}
		skillsDialog() {
			if (!this.boot) return;
			const modal = this.dialog("Skills", '<div data-skills-body><div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading skills…</div></div>');
			const body = modal.element.querySelector("[data-skills-body]");
			const load = async () => {
				body.innerHTML = '<div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading skills…</div>';
				try { const data = await this.api("skills"); if (modal.closed) return; body.innerHTML = skillsHTML(data); }
				catch (error) { if (modal.closed) return; body.innerHTML = '<div class="fi-inline-error" role="alert"><p>' + esc(userError(error)) + "</p>" + button("skills-retry", "Try again", "retry") + "</div>"; }
			};
			modal.element.addEventListener("click", (event) => { const target = event.target.closest('[data-action="skills-retry"]'); if (target && !target.disabled && !modal.busy) modal.run(load); });
			modal.run(load);
		}
		approvalsDialog() {
			if (!this.boot) return;
			const modal = this.dialog("Approvals", '<p class="fi-dialog-copy">Requests waiting across all of your conversations. A decision here resumes or stops the work in its own conversation.</p><div class="fi-queue-toolbar">' + button("queue-refresh", "Refresh", "retry", "fi-text-btn") + '</div><div data-queue-body></div>');
			const body = modal.element.querySelector("[data-queue-body]");
			const load = async () => {
				body.innerHTML = '<div class="fi-loading" role="status"><span class="fi-spinner"></span> Loading approvals…</div>';
				try {
					const rows = await this.api("frappe.client.get_list", { doctype: "Intelligence Approval", filters: { status: "pending" }, fields: ["name", "conversation", "tool_name", "preview_json", "status", "expires_at", "creation"], order_by: "creation asc", limit_page_length: 100 });
					if (modal.closed) return; body.innerHTML = queueHTML(rows);
				} catch (error) { if (modal.closed) return; body.innerHTML = '<div class="fi-inline-error" role="alert"><p>' + esc(userError(error)) + "</p>" + button("queue-retry", "Try again", "retry") + "</div>"; }
			};
			modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-action]");
				if (!target || target.disabled || modal.busy) return;
				const action = target.dataset.action;
				if (action === "queue-refresh" || action === "queue-retry") return modal.run(load);
				if (action === "queue-open") { const name = target.dataset.name; modal.close(); if (name) this.select(name); return; }
				if (action === "queue-approve" || action === "queue-deny") {
					modal.run(async () => { await this.api("approve", { approval: target.dataset.name, decision: action === "queue-approve" ? "approve" : "deny" }); await load(); this.poller.start(0); });
				}
			});
			modal.run(load);
		}
		scopeDialog() {
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
					if (problem) { const box = modal.element.querySelector(".fi-modal-error"); box.hidden = false; box.textContent = problem; return; }
					modal.run(async () => {
						await this.api("frappe.client.set_value", { doctype: "Intelligence Settings", name: "Intelligence Settings", fieldname: { enabled_tools: state.tools.filter((tool) => tool.enabled).map((tool) => tool.name).join("\n"), allowed_read_doctypes: state.read.join("\n"), allowed_write_doctypes: state.write.join("\n") } });
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
	}
	function trapFocus(event, container) {
		const nodes = Array.from(container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter((node) => !node.closest("[hidden]") && (node.getClientRects ? node.getClientRects().length : true));
		if (!nodes.length) { event.preventDefault(); return; } const first = nodes[0], last = nodes[nodes.length - 1];
		if (event.shiftKey && (global.document.activeElement === first || !container.contains(global.document.activeElement))) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (global.document.activeElement === last || !container.contains(global.document.activeElement))) { event.preventDefault(); first.focus(); }
	}
	let singleton, installed = false, drawer, pageHost, toggle, drawerFocus;
	function getApp() {
		if (!singleton) { singleton = new App(); singleton.onClose = closeDrawer; singleton.onExpand = () => { closeDrawer(); global.frappe.set_route("intelligence-chat"); }; singleton.onBackground = (name, message) => { if (toggle) { toggle.classList.add("has-update"); toggle.title = message; toggle.setAttribute("aria-label", "Open Intelligence. " + message); } }; }
		return singleton;
	}
	function deskReady() { return !!(global.document && global.frappe && global.frappe.boot && global.frappe.session && global.frappe.session.user && global.frappe.session.user !== "Guest" && global.frappe.get_route); }
	function routeIsPage() { const route = global.frappe.get_route(); return route && route[0] === "intelligence-chat"; }
	function openDrawer() {
		if (!deskReady()) return; const app = getApp(); if (drawer && !drawer.hidden) { closeDrawer(); return; }
		if (!drawer) { drawer = global.document.createElement("div"); drawer.className = "fi-drawer-shell"; drawer.hidden = true; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); drawer.setAttribute("aria-label", "Intelligence contextual drawer"); drawer.tabIndex = -1; drawer.addEventListener("keydown", (event) => { if (event.key === "Tab") trapFocus(event, drawer); if (event.key === "Escape" && !app.modal) { event.preventDefault(); closeDrawer(); } }); global.document.body.appendChild(drawer); }
		drawerFocus = global.document.activeElement; drawer.hidden = false; app.context = contextFromRoute(global.frappe.get_route()); app.show(drawer, "drawer"); if (toggle) { toggle.classList.remove("has-update"); toggle.setAttribute("aria-expanded", "true"); } drawer.focus(); global.setTimeout(() => { if (!drawer.hidden) app.$("textarea").focus(); }, 0);
	}
	function closeDrawer() { if (!drawer || drawer.hidden) return; drawer.hidden = true; if (toggle) toggle.setAttribute("aria-expanded", "false"); if (singleton) { if (pageHost && routeIsPage()) singleton.show(pageHost, "page"); else singleton.hide(); } if (drawerFocus && drawerFocus.isConnected) drawerFocus.focus(); }
	function showPage(host) { if (!deskReady()) return; pageHost = host.jquery ? host[0] : host; if (drawer) drawer.hidden = true; if (toggle) toggle.setAttribute("aria-expanded", "false"); getApp().show(pageHost, "page"); }
	function install() {
		if (installed || !deskReady()) return; installed = true;
		toggle = global.document.createElement("button"); toggle.type = "button"; toggle.className = "fi-global-toggle"; toggle.setAttribute("aria-label", "Open Intelligence"); toggle.setAttribute("aria-expanded", "false"); toggle.title = "Intelligence · Ctrl/⌘ Shift I"; toggle.innerHTML = '<span class="fi-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>Intelligence</span><span class="fi-toggle-dot" aria-hidden="true"></span>'; toggle.addEventListener("click", openDrawer); global.document.body.appendChild(toggle);
		global.document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") { event.preventDefault(); openDrawer(); } if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k" && singleton && singleton.visible && !singleton.modal) { event.preventDefault(); singleton.root.classList.add("fi-sidebar-open"); singleton.$('[data-input="search"]').focus(); } });
		const routeChange = () => { if (!singleton) return; if (drawer && !drawer.hidden) { singleton.context = contextFromRoute(global.frappe.get_route()); singleton.renderContext(); } else if (!routeIsPage()) singleton.hide(); };
		if (global.frappe.router && global.frappe.router.on) global.frappe.router.on("change", routeChange);
		if (global.frappe.realtime && global.frappe.realtime.on) global.frappe.realtime.on("intelligence_update", (event) => { if (!singleton || !event || !event.conversation) return; if (singleton.visible || singleton.watched.has(event.conversation)) { singleton.lastList = 0; singleton.poller.start(100); } });
		global.addEventListener("online", () => { if (singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
		global.document.addEventListener("visibilitychange", () => { if (!global.document.hidden && singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
		global.addEventListener("pagehide", () => { if (singleton) singleton.poller.stop(); });
		global.addEventListener("pageshow", () => { if (singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
	}
	return { install, showPage, toggle: openDrawer, close: closeDrawer, App, Poller, utils: { esc, safeURL, markdown, contextFromRoute, userError, previewHTML, skillsHTML, queueHTML, scopeState, scopeProblem, scopeHTML, stamp }, request };
});
