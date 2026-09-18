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
	function safeURL(value) {
		const raw = String(value || "").trim();
		if (!raw || /[\x00-\x20\x7f\\]/.test(raw) || raw.startsWith("//")) return "";
		if (raw.startsWith("/")) {
			try { const local = new URL(raw, "https://intelligence.invalid"); return /^\/((?:app|desk)(?:\/|$)|private\/files\/|files\/|api\/method\/frappe\.)/.test(local.pathname) && !/%(?:00|0a|0d|5c)/i.test(raw) ? local.pathname + local.search + local.hash : ""; } catch (_) { return ""; }
		}
		try { const url = new URL(raw); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; } catch (_) { return ""; }
	}
	function inline(text) {
		// Tokenize before escaping. Never pass model HTML through a Markdown/HTML renderer.
		const pattern = /(`[^`\n]+`|!\[[^\]\n]*\]\([^\s)]*\)|\[[^\]\n]+\]\([^\s)]*\)|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*)/g;
		let output = "", cursor = 0;
		for (const match of String(text).matchAll(pattern)) {
			output += esc(text.slice(cursor, match.index)); const token = match[0];
			if (token[0] === "`") output += "<code>" + esc(token.slice(1, -1)) + "</code>";
			else if (token.startsWith("***")) output += "<strong><em>" + esc(token.slice(3, -3)) + "</em></strong>";
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
	function dashed(doctype) { return String(doctype || "").trim().toLowerCase().replace(/[\s_]+/g, "-"); }
	function previewData(preview) { const data = parsed(preview, { summary: String(preview || "") }); return data && typeof data === "object" ? data : { summary: String(data || "") }; }
	function fileNameOf(data) {
		const details = data && data.details && typeof data.details === "object" ? data.details : {};
		return typeof details.file_name === "string" ? details.file_name.trim() : "";
	}
	function isFileAction(data) {
		const target = data && data.target && typeof data.target === "object" ? data.target : {};
		return (data && (data.doctype || target.doctype)) === "File" || String(data && data.operation || "") === "read_attachment";
	}
	function actionSentence(preview, toolName) {
		const data = previewData(preview);
		if (data.action) return String(data.action);
		if (isFileAction(data)) {
			const fileName = fileNameOf(data);
			return "Read attachment" + (fileName ? " '" + fileName + "'" : "");
		}
		const target = data.target && typeof data.target === "object" ? data.target : {};
		const doctype = data.doctype || target.doctype || "";
		const name = data.name || target.name || "";
		const operation = String(data.operation || "").toLowerCase();
		const tool = String(toolName || "").toLowerCase();
		let verb = "";
		if (operation === "search" || operation === "list") verb = "Search";
		else if (operation === "read" || operation === "get") verb = "Read";
		else if (operation === "create") verb = "Create";
		else if (operation === "update") verb = "Update";
		else if (operation === "delete") verb = "Delete";
		else if (operation === "submit") verb = "Submit";
		else if (operation === "cancel") verb = "Cancel";
		else if (operation === "report" || operation === "run_report") verb = "Run";
		if (!verb) {
			verb = "Run";
			if (/create|insert|new/.test(tool)) verb = "Create";
			else if (/update|edit|set|modify/.test(tool)) verb = "Update";
			else if (/delete|remove/.test(tool)) verb = "Delete";
			else if (/submit/.test(tool)) verb = "Submit";
			else if (/cancel/.test(tool)) verb = "Cancel";
			else if (/search|list|find/.test(tool)) verb = "Search";
			else if (/read|get|fetch|open/.test(tool)) verb = "Read";
		}
		if (!doctype) return verb + " requested action";
		return verb + " " + doctype + (name ? " '" + name + "'" : verb === "Search" || verb === "Read" && !name ? " records" : "");
	}
	function fileChip(preview) {
		const data = previewData(preview);
		const fileName = fileNameOf(data);
		if (!fileName) return "";
		return '<span class="fi-record-chip fi-file-ref">' + icon("file") + "<span>" + esc(fileName) + "</span></span>";
	}
	function recordLink(preview) {
		const data = previewData(preview);
		if (isFileAction(data)) return fileChip(data);
		const target = data.target && typeof data.target === "object" ? data.target : {};
		const doctype = data.doctype || target.doctype, name = data.name || target.name;
		if (!doctype || !name) return "";
		const url = safeURL("/app/" + dashed(doctype) + "/" + encodeURIComponent(name));
		return url ? '<a class="fi-record-chip" href="' + esc(url) + '">' + icon("link") + "<span>" + esc(doctype) + " / " + esc(name) + "</span></a>" : "";
	}
	function toolIcon(preview, toolName) {
		const sentence = actionSentence(preview, toolName);
		const verb = sentence.split(" ")[0];
		return { Search: "search", Read: "file", Create: "plus", Update: "edit", Delete: "close", Submit: "check", Cancel: "close", Run: "grid" }[verb] || "wrench";
	}
	function previewHTML(preview) {
		const data = previewData(preview);
		const summary = data.summary || data.description || "";
		// Structured before/after values stay behind a details toggle; the table cells
		// show a compact label instead of raw JSON.
		const value = (entry) => {
			if (entry == null) return "-";
			if (typeof entry !== "object") return esc(String(entry));
			const label = Array.isArray(entry) ? entry.length + " item" + (entry.length === 1 ? "" : "s") : Object.keys(entry).length + " field" + (Object.keys(entry).length === 1 ? "" : "s");
			return '<details class="fi-change-value"><summary>' + esc(label) + "</summary><pre>" + esc(JSON.stringify(entry, null, 2)) + "</pre></details>";
		};
		let html = summary ? '<p class="fi-approval-summary">' + esc(summary) + "</p>" : "";
		if (Array.isArray(data.changes) && data.changes.length) html += '<div class="fi-change-table"><table><thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead><tbody>' + data.changes.map((change) => "<tr><th>" + esc(change.label || change.field) + "</th><td>" + value(change.before) + "</td><td>" + value(change.after) + "</td></tr>").join("") + "</tbody></table></div>";
		// Only the server's purpose-built approval preview is displayed. Never render model tool-call metadata.
		const details = Object.fromEntries(Object.entries(data).filter(([key]) => !["summary", "description", "metadata", "action", "operation", "target", "changes", "doctype", "name"].includes(key)));
		if (Object.keys(details).length) html += '<details class="fi-proposal"><summary>Technical details</summary><pre>' + esc(JSON.stringify(details.details && Object.keys(details).length === 1 ? details.details : details, null, 2)) + "</pre></details>";
		return html;
	}
	function fileCardHTML(file, options) {
		const url = safeURL(file && file.file_url);
		const label = String(file && file.file_name || "Attachment");
		const size = file && Number(file.file_size) ? '<span class="fi-file-size">' + esc(Math.ceil(Number(file.file_size) / 1024) + " KB") + "</span>" : "";
		const attach = options && options.attach ? button("reuse-file", options.attachLabel || "Attach", "plus", "fi-text-btn fi-file-attach", 'data-name="' + esc(file.name) + '"') : "";
		return '<article class="fi-file-card" data-file="' + esc(file && file.name || "") + '"><span class="fi-file-icon">' + icon("file") + '</span><div class="fi-file-info"><strong>' + esc(label) + "</strong>" + size + "</div>" + (url ? '<a class="fi-file-open" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open</a>' : "") + attach + "</article>";
	}
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
			this.boot = null; this.conversations = []; this.sharedConversations = []; this.selected = null; this.snapshot = null; this.drafts = new Map(); this.watched = new Map(); this.pending = new Set(); this.inflight = new Map(); this.history = new Map(); this.expandedTools = new Set();
			this.visible = false; this.archived = false; this.provider = ""; this.context = null; this.loading = false; this.online = true; this.error = ""; this.notice = ""; this.selectVersion = 0; this.listVersion = 0; this.lastList = 0; this.failures = 0; this.messageSignature = ""; this.renaming = false;
			this.poller = new Poller(() => this.poll()); this.root = this.doc.createElement("section"); this.root.className = "fi-app"; this.root.setAttribute("aria-label", "Intelligence workspace");
			this.root.innerHTML = this.shell(); this.bind(); this.render();
		}
		shell() {
			return '<aside class="fi-sidebar" aria-label="Conversations">'
				+ '<div class="fi-sidebar-top">' + button("new", "New conversation", "plus", "fi-new") + '</div>'
				+ '<div class="fi-sidebar-label"><span data-slot="list-label">Conversations</span>' + iconButton("archive-filter", "Show archived conversations", "archive", 'aria-pressed="false"') + "</div>"
				+ '<nav class="fi-conversation-list" data-slot="conversations" aria-label="Conversation list"></nav>'
				+ '<div class="fi-sidebar-label fi-shared-label" data-slot="shared-label" hidden><span>Shared with me</span></div>'
				+ '<nav class="fi-conversation-list fi-shared-list" data-slot="shared" aria-label="Shared with me" hidden></nav>'
				+ '<footer class="fi-sidebar-footer"><div class="fi-menu-wrap fi-settings-menu">'
				+ '<button type="button" class="fi-settings-btn" data-action="menu" aria-haspopup="menu" aria-expanded="false">' + icon("settings") + "<span>Settings</span>" + icon("chevron") + "</button>"
				+ '<div class="fi-menu fi-menu-up" data-slot="menu" role="menu" hidden>'
				+ '<button type="button" role="menuitem" data-action="settings">' + icon("settings") + "<span>Providers &amp; models</span></button>"
				+ '<button type="button" role="menuitem" data-action="memory">' + icon("memory") + "<span>Memory</span></button>"
				+ '<button type="button" role="menuitem" data-action="skills">' + icon("grid") + "<span>Skills</span></button>"
				+ '<button type="button" role="menuitem" data-action="scope">' + icon("target") + "<span>Scope</span></button>"
				+ '<button type="button" role="menuitem" data-action="app-settings">' + icon("settings") + "<span>Intelligence settings</span></button>"
				+ "</div></div>"
				+ '<div class="fi-private-note">' + icon("lock") + "<span>Only you can see your conversations</span></div></footer></aside>"
				+ '<div class="fi-main"><header class="fi-header"><div class="fi-header-left">'
				+ iconButton("sidebar", "Toggle conversations", "panel", 'aria-expanded="true"')
				+ '<div class="fi-heading"><button type="button" class="fi-title-btn" data-action="rename-title" title="Rename conversation"><h2 data-slot="title">New conversation</h2></button><span data-slot="subtitle" class="fi-subtitle"></span></div></div>'
				+ '<div class="fi-header-actions">'
				+ '<span data-slot="shared-chip"></span>'
				+ iconButton("share", "Share conversation", "share")
				+ iconButton("archive", "Archive conversation", "archive")
				+ iconButton("expand", "Open full workspace", "expand") + iconButton("close", "Close Intelligence", "close")
				+ '</div></header>'
				+ '<div class="fi-banner" data-slot="banner" role="status" hidden></div>'
				+ '<div class="fi-thread-wrap"><div class="fi-thread" data-slot="thread" tabindex="0" aria-label="Messages"><div class="fi-thread-inner" data-slot="messages"></div></div>'
				+ '<button type="button" class="fi-scroll-bottom" data-action="scroll-bottom" hidden aria-label="Scroll to the latest messages">' + icon("down") + "<span>Latest</span></button></div>"
				+ '<div class="fi-bottom"><div class="fi-run" data-slot="run" aria-live="polite" hidden></div><div class="fi-context-list" data-slot="context"></div>'
				+ '<div class="fi-readonly" data-slot="readonly" hidden></div>'
				+ '<form class="fi-composer" aria-label="Message composer"><textarea data-input="message" rows="2" maxlength="100000" aria-label="Message Intelligence" placeholder="Ask a question, explore your data, or get something done…"></textarea><div class="fi-attachments" data-slot="attachments"></div><div class="fi-composer-toolbar"><div class="fi-composer-tools">' + iconButton("attach", "Attach a private PDF or text file", "attach") + '<label class="fi-provider-label"><span class="fi-provider-dot" aria-hidden="true"></span><select data-input="provider" aria-label="Provider and model"></select>' + icon("down") + '</label></div><button type="submit" class="fi-send" aria-label="Send message" title="Send message">' + icon("arrow") + '</button></div></form>'
				+ '<div class="fi-composer-caption"><span>' + icon("lock") + ' <span data-slot="approval-mode">You approve every tool action</span></span><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span></div></div></div>';
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
				} catch (error) { this.error = userError(error); } finally { this.loading = false; this.render(); this.poller.start(0); this.initializing = null; }
			})(); return this.initializing;
		}
		show(host, mode) {
			this.visible = true; this.mode = mode || "page"; this.root.classList.toggle("fi-drawer-app", this.mode === "drawer"); host.appendChild(this.root);
			// Below the sidebar breakpoint the drawer-style conversation column overlays
			// the content; start collapsed so the header stays reachable.
			if (this.mode === "page" && global.innerWidth && global.innerWidth <= 760) { this.root.classList.add("fi-sidebar-collapsed"); const trigger = this.$('[data-action="sidebar"]'); if (trigger) trigger.setAttribute("aria-expanded", "false"); }
			this.render();
			if (!this.boot) this.init(); else this.poller.start(0);
			this.fitViewport();
			if (!this.viewportBound && global.addEventListener) { this.viewportBound = true; global.addEventListener("resize", () => this.fitViewport()); }
		}
		hide() { this.visible = false; this.closeMenu(); this.poller.stop(); if (this.watched.size) this.poller.start(1000); }
		// Desk page bodies are not always height-constrained; if the document itself
		// started scrolling, pin the app to the remaining viewport so the composer
		// stays visible and only the thread and conversation list scroll.
		fitViewport() {
			if (!this.root.isConnected || typeof this.root.getBoundingClientRect !== "function") return;
			this.root.style.height = "";
			if (this.mode !== "page") return;
			const doc = this.doc.documentElement, viewport = Number(global.innerHeight) || 0;
			if (!doc || !viewport || doc.scrollHeight <= viewport + 4) return;
			const available = Math.floor(viewport - this.root.getBoundingClientRect().top - 8);
			if (available >= 320) this.root.style.height = available + "px";
		}
		closeMenu() { const menu = this.slot("menu"); if (menu) menu.hidden = true; const trigger = this.$('[data-action="menu"]'); if (trigger) trigger.setAttribute("aria-expanded", "false"); }
		async refreshList() {
			const version = ++this.listVersion;
			const results = await Promise.all([
				this.api("list_conversations", { archived: this.archived ? 1 : 0 }),
				this.api("list_conversations", { shared: 1 })
			]);
			if (version !== this.listVersion) return;
			this.conversations = Array.isArray(results[0]) ? results[0] : [];
			this.sharedConversations = Array.isArray(results[1]) ? results[1] : [];
			this.lastList = Date.now();
			for (const row of this.conversations) if (row.active_run && !this.watched.has(row.name)) this.watched.set(row.name, { name: typeof row.active_run === "object" ? row.active_run.name : row.active_run, state: "running" });
			this.renderSidebar();
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
			finally { if (version === this.selectVersion) { this.loadingConversation = false; this.render(); this.poller.start(0); } }
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
		render() { this.renderSidebar(); this.renderHeader(); this.renderMessages(); this.renderRun(); this.renderContext(); this.renderAttachments(); this.renderProviders(); this.renderControls(); this.renderBanner(); }
		providerRow() {
			const providers = this.boot && this.boot.providers || [];
			return providers.find((provider) => provider.name === this.provider) || null;
		}
		renderHeader() {
			const title = this.snapshot && this.snapshot.conversation.title || (this.selected ? "Conversation" : "New conversation");
			if (!this.renaming) this.slot("title").textContent = title;
			const row = this.providerRow();
			const effort = row && EFFORTS.includes(row.thinking_effort) ? row.thinking_effort : "Auto";
			let subtitle;
			if (this.snapshot && Number(this.snapshot.conversation.archived)) subtitle = "Archived · read only";
			else if (this.snapshot && this.snapshot.can_post === false) subtitle = "Shared by " + (this.snapshot.conversation.owner || "another user") + " · read only";
			else if (row) subtitle = row.title + " · " + row.model + " · effort " + effort;
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
			const share = this.$('[data-action="share"]'); share.setAttribute("aria-label", shared ? "Stop sharing this conversation" : "Share conversation (read only link)"); share.title = share.getAttribute("aria-label");
			const mode = this.boot && this.boot.defaults && this.boot.defaults.approval_mode;
			this.slot("approval-mode").textContent = mode ? "Approval mode: " + mode : "You approve every tool action";
		}
		conversationRowsHTML(rows) {
			const list = Array.isArray(rows) ? rows : this.conversations;
			return list.length ? list.map((row) => '<button type="button" class="fi-conversation ' + (this.selected === row.name ? "is-active" : "") + '" data-action="select" data-name="' + esc(row.name) + '" ' + (this.selected === row.name ? 'aria-current="true"' : "") + '><span class="fi-conversation-icon">' + icon("chat") + '</span><span class="fi-conversation-info"><span class="fi-conversation-title">' + esc(row.title || "Untitled conversation") + '</span><span class="fi-conversation-meta">' + esc(time(row.modified)) + (row.shared ? '<span class="fi-list-status">Shared</span>' : "") + (row.active_run ? '<span class="fi-list-status">In progress</span>' : "") + '</span></span>' + (row.active_run ? '<span class="fi-status-dot" aria-label="Active run"></span>' : "") + '</button>').join("") : "";
		}
		renderSidebar() {
			const signature = JSON.stringify([this.conversations, this.sharedConversations, this.selected, this.archived, this.loading]);
			if (signature === this.sidebarSignature) return; this.sidebarSignature = signature;
			this.slot("list-label").textContent = this.archived ? "Archived conversations" : "Conversations";
			const filter = this.$('[data-action="archive-filter"]'); filter.setAttribute("aria-pressed", String(this.archived)); filter.title = this.archived ? "Show active conversations" : "Show archived conversations";
			const empty = '<div class="fi-list-empty">' + (this.loading ? "Loading conversations…" : this.archived ? "No archived conversations." : "Your conversations will appear here.") + "</div>";
			this.slot("conversations").innerHTML = this.loading && !this.conversations.length ? '<div class="fi-skel-list">' + '<span class="fi-skel-line"></span>'.repeat(4) + "</div>" : this.conversationRowsHTML() || empty;
			const sharedSlot = this.slot("shared"), sharedLabel = this.slot("shared-label");
			const showShared = !this.archived && this.sharedConversations.length > 0;
			sharedSlot.hidden = !showShared; sharedLabel.hidden = !showShared;
			sharedSlot.innerHTML = showShared ? this.conversationRowsHTML(this.sharedConversations) : "";
		}
		renderProviders() {
			const select = this.$('[data-input="provider"]'); const providers = this.boot && this.boot.providers || [];
			let options = providers.map((provider) => '<option value="' + esc(provider.name) + '">' + esc(provider.title + " · " + provider.model) + "</option>").join("");
			if (this.selected && !providers.some((provider) => provider.name === this.provider)) options += '<option value="' + esc(this.provider) + '">Provider unavailable</option>';
			if (select.dataset.options !== options) { select.innerHTML = options || '<option value="">Set up a provider</option>'; select.dataset.options = options; }
			select.value = this.provider;
			select.title = this.selected ? "This conversation uses its original provider. Start a new conversation to switch." : "Choose a configured provider and model";
		}
		renderBanner() {
			const banner = this.slot("banner"); const message = this.error || (!this.online ? "Connection interrupted. Reconnecting automatically; your run continues on the server." : this.notice);
			const signature = JSON.stringify([message, !!this.error]); if (signature === this.bannerSignature) return; this.bannerSignature = signature;
			banner.hidden = !message; banner.classList.toggle("is-error", !!this.error); banner.setAttribute("role", this.error ? "alert" : "status");
			banner.innerHTML = message ? icon(this.error ? "info" : "retry") + "<span>" + esc(message) + "</span>" + button("refresh", "Refresh", null, "fi-text-btn") + iconButton("dismiss", "Dismiss notification", "close") : "";
		}
		thinkingHTML() {
			return '<div class="fi-thinking" role="status" aria-label="Intelligence is working"><span class="fi-avatar fi-avatar-ai"><img class="fi-avatar-logo" src="' + LOGO + '" alt=""></span><span class="fi-thinking-dots"><i></i><i></i><i></i></span></div>';
		}
		renderMessages() {
			const slot = this.slot("messages"), thread = this.slot("thread");
			const signature = JSON.stringify([this.loading, this.loadingConversation, this.selected, this.snapshot && this.snapshot.messages, this.snapshot && this.snapshot.approvals, this.snapshot && this.snapshot.files, this.snapshot && this.snapshot.run, this.snapshot && this.snapshot.has_earlier_messages, this.snapshot && this.snapshot.can_post, this.boot && this.boot.providers]);
			if (signature === this.messageSignature) return; this.messageSignature = signature;
			const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
			if (this.loading || this.loadingConversation) { slot.innerHTML = '<div class="fi-skel-thread" role="status" aria-label="Loading"><span class="fi-skel-line fi-skel-wide"></span><span class="fi-skel-line"></span><span class="fi-skel-line fi-skel-short"></span><span class="fi-skel-line fi-skel-wide"></span><span class="fi-skel-line"></span></div>'; return; }
			const messages = this.snapshot && this.snapshot.messages || [];
			const approvals = this.snapshot && this.snapshot.approvals || [];
			const files = this.snapshot && this.snapshot.files || [];
			if (!messages.length && !approvals.length) {
				const noProviders = this.boot && !(this.boot.providers || []).length;
				const hour = new Date().getHours();
				const daypart = hour < 5 || hour >= 18 ? "evening" : hour < 12 ? "morning" : "afternoon";
				const userName = this.boot && this.boot.user_name || "";
				const greeting = userName ? "Good " + daypart + ", " + esc(userName) + "." : "How can I help?";
				slot.innerHTML = '<div class="fi-welcome"><div class="fi-welcome-symbol" aria-hidden="true"><img class="fi-welcome-logo" src="' + LOGO + '" alt=""></div><h2>' + greeting + '</h2><p>Ask about your business. Find the right records.<br>Take the next step, with you in control.</p>' + (noProviders ? '<div class="fi-setup-note"><strong>Connect a provider to get started</strong><p>Use your own API key and choose the model that works for you.</p>' + button("settings", "Set up a provider", "plus", "fi-primary") + "</div>" : '<div class="fi-starters"><button type="button" data-action="starter" data-prompt="Give me my briefing for today: what needs my attention across my companies, invoices, emails and tasks?"><span class="fi-starter-icon">' + icon("sun") + '</span><strong>Today&rsquo;s briefing</strong><span>What needs your attention right now</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Help me find the records I need to review today."><span class="fi-starter-icon">' + icon("search") + '</span><strong>Find what matters</strong><span>Explore records you can access</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Help me understand this workflow before making any changes."><span class="fi-starter-icon">' + icon("chat") + '</span><strong>Think it through</strong><span>Understand a process or next step</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Review an attached document and help me identify the next steps."><span class="fi-starter-icon">' + icon("file") + '</span><strong>Start with a document</strong><span>Work with a private PDF or text file</span>' + icon("chevron") + "</button></div>") + '<div class="fi-welcome-foot">' + icon("lock") + " Private conversations. Explicit approvals. Your permissions.</div></div>";
			} else {
				// Merge messages and tool cards into one chronological feed: cards
				// grouped after all messages would bury the final answer mid-thread.
				const canPost = !this.readOnly();
				const feed = messages.filter((message) => ["user", "assistant"].includes(message.role) && message.content).map((message) => ({ creation: message.creation || "", type: "message", html: this.messageHTML(message) })).concat(approvals.map((approval) => ({ creation: approval.creation || "", type: "approval", approval }))).sort((a, b) => (a.creation < b.creation ? -1 : a.creation > b.creation ? 1 : 0));
				// Consecutive resolved tool actions collapse into one card; a pending
				// approval always breaks the group and stays fully visible.
				let body = "", group = [];
				const flush = () => { if (group.length) { body += group.length > 1 ? this.toolGroupHTML(group, canPost) : this.approvalHTML(group[0], canPost); group = []; } };
				for (const entry of feed) {
					if (entry.type === "approval" && entry.approval.status !== "pending") { group.push(entry.approval); continue; }
					flush(); body += entry.type === "approval" ? this.approvalHTML(entry.approval, canPost) : entry.html;
				}
				flush();
				const run = this.snapshot && this.snapshot.run;
				const thinking = run && ["queued", "running"].includes(run.state) ? this.thinkingHTML() : "";
				const selected = new Set(this.draft().attachments.map((file) => file.name));
				const fileCards = files.length ? '<div class="fi-file-cards" aria-label="Conversation files">' + files.map((file) => fileCardHTML(file, canPost && !selected.has(file.name) ? { attach: true, attachLabel: "Attach" } : canPost ? { attach: true, attachLabel: "Attached" } : null)).join("") + "</div>" : "";
				slot.innerHTML = (this.snapshot.has_earlier_messages ? '<div class="fi-history-more">' + button("earlier", "Load earlier messages", "retry", "fi-text-btn") + "</div>" : "") + '<div class="fi-thread-start">' + icon("lock") + (this.snapshot.conversation && Number(this.snapshot.conversation.shared) ? " This conversation is shared read only" : " This conversation is private to you") + "</div>" + body + thinking + fileCards;
				this.bindFileCards(slot);
			}
			if (nearBottom || !this.snapshot || this.snapshot.messages && this.snapshot.messages.length < 2) thread.scrollTop = thread.scrollHeight;
			this.syncScrollButton();
		}
		syncScrollButton() {
			const thread = this.slot("thread"), trigger = this.$('[data-action="scroll-bottom"]');
			if (!thread || !trigger) return;
			trigger.hidden = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
		}
		toolGroupHTML(list, canPost) {
			const key = list.map((approval) => approval.name).join("|"), open = this.expandedTools.has(key);
			const active = list.some((approval) => ["approved", "executing"].includes(approval.status));
			const title = active ? "Working through " + list.length + " steps" : "Used " + list.length + " tools";
			return '<section class="fi-tool-group' + (open ? " is-open" : "") + '" aria-label="Tool actions"><button type="button" class="fi-tool-group-head" data-action="toggle-tools" data-key="' + esc(key) + '" aria-expanded="' + String(open) + '"><span class="fi-tool-group-icon">' + icon("wrench") + '</span><span class="fi-tool-group-title">' + esc(title) + '</span>' + (active ? '<span class="fi-spinner fi-tool-group-spinner" aria-label="Working"></span>' : "") + '<span class="fi-tool-group-chevron">' + icon("down") + "</span></button>" + '<div class="fi-tool-group-body"' + (open ? "" : " hidden") + ">" + list.map((approval) => this.toolRowHTML(approval, canPost)).join("") + '<details class="fi-proposal fi-group-details"><summary>Technical details</summary><pre>' + esc(JSON.stringify(list.map((approval) => ({ tool: approval.tool_name, status: approval.status, preview: previewData(approval.preview) })), null, 2)) + "</pre></details></div></section>";
		}
		toolRowHTML(approval, canPost) {
			const status = String(approval.status || "pending");
			const sentence = actionSentence(approval.preview, approval.tool_name);
			const summary = previewData(approval.preview).summary || "";
			const chip = recordLink(approval.preview);
			return '<div class="fi-tool-row"><span class="fi-tool-icon">' + icon(toolIcon(approval.preview, approval.tool_name)) + '</span><div class="fi-tool-info"><strong>' + esc(sentence) + "</strong>" + (summary && summary !== sentence ? "<p>" + esc(summary) + "</p>" : "") + (chip ? '<div class="fi-approval-link">' + chip + "</div>" : "") + '</div><span class="fi-pill fi-pill-' + esc(status) + '">' + esc(status) + "</span></div>";
		}
		bindFileCards(slot) {
			for (const element of slot.querySelectorAll('[data-action="reuse-file"]')) {
				if (element.dataset.bound) continue; element.dataset.bound = "1";
				element.addEventListener("click", () => {
					const files = this.snapshot && this.snapshot.files || [];
					const file = files.find((entry) => entry.name === element.dataset.name);
					if (!file || this.readOnly() || this.draft().attachments.some((entry) => entry.name === file.name)) return;
					this.draft().attachments.push(file); this.renderAttachments(); this.renderControls();
					element.disabled = true; const label = element.querySelector("span"); if (label) label.textContent = "Attached";
				});
			}
		}
		messageHTML(message) {
			return '<article class="fi-message fi-message-' + esc(message.role) + '" data-message="' + esc(message.name) + '"><div class="fi-message-heading"><span class="fi-avatar ' + (message.role === "assistant" ? "fi-avatar-ai" : "") + '">' + (message.role === "assistant" ? '<img class="fi-avatar-logo" src="' + LOGO + '" alt="">' : "Y") + "</span><strong>" + (message.role === "assistant" ? "Intelligence" : "You") + "</strong><span>" + esc(time(message.creation)) + "</span>" + (message.status === "interrupted" ? '<span class="fi-message-interrupted">Interrupted</span>' : "") + '</div><div class="fi-message-content">' + markdown(message.content) + "</div></article>";
		}
		approvalHTML(approval, canPost) {
			const pending = approval.status === "pending", locked = this.pending.has("approval:" + approval.name);
			const status = String(approval.status || "pending");
			const sentence = actionSentence(approval.preview, approval.tool_name);
			const link = recordLink(approval.preview);
			const decisions = pending && canPost !== false && canPost !== 0;
			return '<section class="fi-approval ' + (pending ? "is-pending" : "") + '" aria-label="Tool action"><div class="fi-approval-top"><span class="fi-approval-icon">' + icon(pending ? "lock" : "check") + '</span><div><span class="fi-eyebrow">' + (pending ? "YOUR APPROVAL IS REQUIRED" : "TOOL ACTION") + "</span><h3>" + esc(sentence) + "</h3>" + (link ? '<div class="fi-approval-link">' + link + "</div>" : "") + '</div><span class="fi-pill fi-pill-' + esc(status) + '">' + esc(status) + "</span></div>" + previewHTML(approval.preview) + (approval.expires_at && pending ? '<p class="fi-approval-expiry">Expires ' + esc(approval.expires_at) + "</p>" : "") + (pending ? (decisions ? '<div class="fi-approval-footer"><span>Nothing runs until you approve.</span><div>' + button("deny", "Deny", null, "", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + button("approve", "Approve action", "check", "fi-primary", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + button("always", "Always allow", null, "fi-text-btn", 'data-name="' + esc(approval.name) + '" title="Approve now and stop asking for this action" ' + (locked ? "disabled" : "")) + "</div></div>" : '<div class="fi-approval-result">Waiting for the owner to decide.</div>') : '<div class="fi-approval-result">' + esc({ approved: "Approved; waiting for execution.", denied: "Denied. This request will not run.", executing: "Executing the approved request.", succeeded: "The approved action completed.", failed: "The action failed. Check the run status.", expired: "This approval expired. Start a new request if it is still needed.", uncertain: "The result could not be confirmed. Check the record before trying again." }[status] || "") + "</div>") + "</section>";
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
		renderAttachments() {
			const signature = JSON.stringify([this.draft().attachments, this.pending.has("upload")]); if (signature === this.attachmentSignature) return; this.attachmentSignature = signature;
			this.slot("attachments").innerHTML = this.draft().attachments.map((file) => '<span class="fi-file-chip">' + icon("file") + "<span>" + esc(file.file_name) + "</span>" + iconButton("remove-file", "Remove " + file.file_name + " from this message", "close", 'data-name="' + esc(file.name) + '"') + "</span>").join("") + (this.pending.has("upload") ? '<span class="fi-file-chip"><span class="fi-spinner"></span>Uploading privately…</span>' : "");
		}
		renderControls() {
			const busy = this.pending.has("send") || this.pending.has("upload");
			const readOnly = this.readOnly();
			const unavailable = !this.boot || !this.boot.enabled || this.loading || this.loadingConversation || !!(this.selected && !this.snapshot);
			const providerAvailable = !!(this.boot && (this.boot.providers || []).some((provider) => provider.name === this.provider));
			const cancel = this.$('[data-action="cancel"]'); if (cancel) cancel.disabled = this.pending.has("cancel") || !!(this.snapshot && this.snapshot.run && this.snapshot.run.cancel_requested);
			const notice = this.slot("readonly"), form = this.$("form"), caption = this.$(".fi-composer-caption");
			const shared = !!(this.snapshot && this.snapshot.conversation && this.snapshot.can_post === false && !Number(this.snapshot.conversation.archived));
			const showNotice = !!this.snapshot && shared;
			notice.hidden = !showNotice;
			notice.innerHTML = showNotice ? icon("lock") + "<span>Shared by " + esc(this.snapshot.conversation.owner || "another user") + " · read only</span>" : "";
			form.hidden = showNotice; caption.hidden = showNotice;
			this.$("textarea").disabled = !!(unavailable || readOnly || this.pending.has("send"));
			this.$(".fi-send").disabled = !!(unavailable || busy || readOnly || this.isActive() || !providerAvailable || !this.draft().text.trim());
			this.$(".fi-send").setAttribute("aria-label", this.pending.has("send") ? "Sending message" : this.isActive() ? "Wait for this run to finish" : "Send message");
			this.$('[data-action="attach"]').disabled = !!(unavailable || busy || readOnly || this.isActive() || !providerAvailable || this.boot && this.boot.capabilities && this.boot.capabilities.attachments === false);
			this.$('[data-input="provider"]').disabled = !!(unavailable || busy || this.selected);
			for (const action of ["new", "archive", "share"]) this.$('[data-action="' + action + '"]').disabled = !!(unavailable || busy || this.pending.has(action));
			for (const element of this.root.querySelectorAll('[data-action="select"]')) element.disabled = busy;
			for (const element of this.root.querySelectorAll('[data-action="approve"], [data-action="deny"], [data-action="always"]')) element.disabled = this.pending.has("approval:" + element.dataset.name);
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
			this.selected = conversation.name; this.selectVersion++; this.drafts.set(conversation.name, draft); this.drafts.delete("new"); this.snapshot = { conversation, messages: [], approvals: [], files: [], run: null, can_post: true }; this.lastList = 0; this.navigate(conversation.name); this.render(); return conversation.name;
		}
		send() {
			if (this.$(".fi-send").disabled || this.pending.has("send")) return Promise.resolve();
			return this.busy("send", async () => {
				this.error = ""; const draft = this.draft(), content = draft.text.trim(), attachments = draft.attachments.map((file) => file.name), context = this.context ? Object.assign({}, this.context) : null;
				const name = await this.ensureConversation();
				try { const run = await this.api("send_message", { conversation: name, content, context: context ? JSON.stringify(context) : null, attachments: JSON.stringify(attachments) });
					if (!run || !run.name) throw { userMessage: "No run was returned. Refresh before trying again; your message may have been saved." };
					draft.text = ""; draft.attachments = []; this.watched.set(name, run); this.snapshot.run = run; this.syncDraft(); this.renderRun(); this.renderMessages(); this.poller.start(0);
					const data = await this.fetchConversation(name); this.accept(name, data); this.lastList = 0;
					// Server auto-titles from the first message; pick it up right away.
					this.refreshList().catch(() => {});
				} catch (error) { this.poller.start(0); throw error; }
			});
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
			if (action === "sidebar") { const collapsed = this.root.classList.toggle("fi-sidebar-collapsed"); target.setAttribute("aria-expanded", String(!collapsed)); return; }
			if (action === "menu") { const menu = this.slot("menu"); menu.hidden = !menu.hidden; target.setAttribute("aria-expanded", String(!menu.hidden)); return; }
			if (action === "archive-filter") { this.archived = !this.archived; this.refreshList().catch((error) => { this.error = userError(error); this.renderBanner(); }); return; }
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
		shareLink() {
			const origin = global.location && global.location.origin ? global.location.origin : "";
			return origin + "/desk/" + PAGE + "/" + this.selected;
		}
		copyShareLink(link, done) {
			if (global.navigator && global.navigator.clipboard) global.navigator.clipboard.writeText(link).then(() => done && done(true)).catch(() => done && done(false));
		}
		shareDialog() {
			if (!this.snapshot) return; const name = this.selected, shared = !!Number(this.snapshot.conversation.shared);
			const link = this.shareLink();
			const copy = shared ? "Anyone with the link and Intelligence access can read this conversation. Only you can post or approve." : "Sharing gives colleagues a read only view of this conversation, including files and tool actions. Only you can post or approve.";
			const commit = async (modal, next) => { await this.api("share_conversation", { conversation: name, shared: next }); this.accept(name, await this.fetchConversation(name)); await this.refreshList(); modal.busy = false; modal.close(); this.notice = next ? "Conversation shared. Anyone with the link can read it." : "Sharing turned off."; this.renderBanner(); };
			const frappe = global.frappe;
			if (frappe && frappe.ui && frappe.ui.Dialog) {
				this.nativeForm(frappe, {
					title: shared ? "Conversation is shared" : "Share this conversation?",
					size: "small",
					fields: [
						{ fieldtype: "HTML", fieldname: "copy", options: '<p class="fi-dialog-copy">' + copy + "</p>" },
						{ fieldname: "link", label: "Read only link", fieldtype: "Data", read_only: 1, default: link }
					],
					primary_action_label: shared ? "Stop sharing" : "Share conversation",
					primary_action: (values, modal) => commit(modal, shared ? 0 : 1),
					secondary_action_label: "Copy link",
					secondary_action: (modal) => this.copyShareLink(link, (ok) => { if (!ok) { modal.error({ userMessage: "Could not copy. Select the link and copy it directly." }); return; } if (frappe.show_alert) frappe.show_alert({ message: "Link copied.", indicator: "green" }); })
				});
				return;
			}
			const modal = this.dialog(shared ? "Conversation is shared" : "Share this conversation?", '<p class="fi-dialog-copy">' + copy + '</p><label class="fi-field control-label">Read only link<input class="form-control" readonly value="' + esc(link) + '" data-share-link onfocus="this.select()"></label><footer>' + (shared ? "" : button("modal-close", "Cancel")) + (shared ? button("confirm-unshare", "Stop sharing", null, "fi-danger") : "") + button("copy-share-link", "Copy link", "link", shared ? "" : "fi-text-btn") + (shared ? "" : button("confirm-share", "Share conversation", "share", "fi-primary")) + "</footer>");
			modal.element.addEventListener("click", (event) => {
				const target = event.target.closest("[data-action]"); if (!target || modal.busy) return;
				if (target.dataset.action === "copy-share-link") { this.copyShareLink(link, (ok) => { if (!ok) return; const label = target.querySelector("span"); if (label) { label.textContent = "Copied"; global.setTimeout(() => { label.textContent = "Copy link"; }, 1800); } }); return; }
				const next = target.dataset.action === "confirm-share" ? 1 : target.dataset.action === "confirm-unshare" ? 0 : null;
				if (next === null) return;
				modal.run(async () => commit(modal, next));
			});
		}
		chooseFile() {
			const input = this.doc.createElement("input"); input.type = "file"; input.accept = ".pdf,.txt,.csv,.md,.json,text/plain,text/csv,application/pdf";
			input.addEventListener("change", () => { const file = input.files && input.files[0]; if (file) this.upload(file); }); input.click();
		}
		upload(file) {
			if (this.pending.has("upload") || this.pending.has("send") || this.isActive() || this.readOnly()) return Promise.resolve();
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
				this.draft().attachments.push(attachment); this.messageSignature = ""; this.renderMessages();
			}).finally(() => this.renderAttachments());
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
			let loadVersion = 0, readOnly = false, modal = null;
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
						if (models.length) modal.set("models", models.join("\n"));
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
					if (modal.instance.set_values) await modal.instance.set_values({
						name: data.name || "", title: data.title || "", kind: data.kind || "OpenAI", model: data.model || "",
						base_url: data.base_url || "", api_key: "", allowed_roles: data.allowed_roles || "", models: data.models || "",
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
					{ fieldname: "models", label: "Model catalog", fieldtype: "Small Text", description: "One model ID per line. Blank allows any model." },
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
						timeout: Number(values.timeout) || 60, models: values.models || ""
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
		async settingsDialogNative(frappe) {
			const readOnly = !this.boot.is_manager;
			let data;
			if (frappe.ui.freeze) frappe.ui.freeze("Loading settings…");
			try { data = await this.api("get_settings"); }
			catch (error) { this.error = userError(error); this.renderBanner(); return; }
			finally { if (frappe.ui.unfreeze) frappe.ui.unfreeze(); }
			const fields = [{ fieldtype: "HTML", fieldname: "settings_copy", options: '<p class="fi-dialog-copy">' + (readOnly ? "Only system managers can change these settings. Your current configuration is shown here." : "Site-wide assistant behavior. Changes apply to every user and every run.") + "</p>" }].concat(SETTINGS_FIELDS.map((field) => Object.assign({}, field, { default: data && data[field.fieldname] !== undefined && data[field.fieldname] !== null ? data[field.fieldname] : field.fieldtype === "Check" ? 0 : "", read_only: readOnly ? 1 : 0 })));
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
			body.innerHTML = SETTINGS_FIELDS.map((field) => this.settingsFieldHTML(field, data[field.fieldname], readOnly)).join("");
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
	let singleton, installed = false, drawer, pageHost, toggle, drawerFocus;
	function getApp() {
		if (!singleton) { singleton = new App(); singleton.onClose = closeDrawer; singleton.onExpand = () => { closeDrawer(); global.frappe.set_route(PAGE); }; }
		return singleton;
	}
	function deskReady() { return !!(global.document && global.frappe && global.frappe.boot && global.frappe.session && global.frappe.session.user && global.frappe.session.user !== "Guest" && global.frappe.get_route); }
	function pageRoute() { const route = global.frappe.get_route(); return route && route[0] === PAGE ? route : null; }
	function routeIsPage() { return !!pageRoute(); }
	// The floating pill stays available across Desk except on the Intelligence page
	// itself, where the full app already fills the content area. syncDesk is called
	// on install, on every route change and from the page lifecycle.
	function syncDesk() {
		if (!deskReady()) return;
		if (toggle) toggle.hidden = routeIsPage();
		const stale = global.document.querySelector("[data-fi-desk]"); if (stale) stale.remove();
		if (global.document.body) global.document.body.classList.toggle("fi-desk-active", routeIsPage());
	}
	function syncRouteSelection() {
		if (!singleton) return;
		const route = pageRoute();
		if (!route) return;
		const name = route[1] || null;
		if (name && name !== singleton.selected) singleton.select(name);
		else if (!name && singleton.selected) singleton.newConversation();
	}
	function openDrawer() {
		if (!deskReady()) return; const app = getApp(); if (drawer && !drawer.hidden) { closeDrawer(); return; }
		if (!drawer) { drawer = global.document.createElement("div"); drawer.className = "fi-drawer-shell"; drawer.hidden = true; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); drawer.setAttribute("aria-label", "Intelligence contextual drawer"); drawer.tabIndex = -1; drawer.addEventListener("keydown", (event) => { if (event.key === "Tab") trapFocus(event, drawer); if (event.key === "Escape" && !app.modal) { event.preventDefault(); closeDrawer(); } }); global.document.body.appendChild(drawer); }
		drawerFocus = global.document.activeElement; drawer.hidden = false; app.context = contextFromRoute(global.frappe.get_route()); app.show(drawer, "drawer"); if (toggle) toggle.setAttribute("aria-expanded", "true"); drawer.focus(); global.setTimeout(() => { if (!drawer.hidden) app.$("textarea").focus(); }, 0);
	}
	function closeDrawer() { if (!drawer || drawer.hidden) return; drawer.hidden = true; if (toggle) toggle.setAttribute("aria-expanded", "false"); if (singleton) { if (pageHost && routeIsPage()) singleton.show(pageHost, "page"); else singleton.hide(); } if (drawerFocus && drawerFocus.isConnected) drawerFocus.focus(); }
	function showPage(host) { if (!deskReady()) return; pageHost = host.jquery ? host[0] : host; if (drawer) drawer.hidden = true; if (toggle) toggle.setAttribute("aria-expanded", "false"); const app = getApp(); app.show(pageHost, "page"); syncDesk(); syncRouteSelection(); }
	function install() {
		if (installed || !deskReady()) return; installed = true;
		toggle = global.document.createElement("button"); toggle.type = "button"; toggle.className = "fi-global-toggle"; toggle.setAttribute("aria-label", "Open Intelligence"); toggle.setAttribute("aria-expanded", "false"); toggle.title = "Intelligence · Ctrl/⌘ Shift I"; toggle.innerHTML = '<img class="fi-toggle-logo" src="' + LOGO + '" alt="" aria-hidden="true"><span>Intelligence</span>'; toggle.addEventListener("click", openDrawer); global.document.body.appendChild(toggle);
		global.document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") { event.preventDefault(); openDrawer(); } });
		const routeChange = () => { syncDesk(); if (!singleton) return; if (drawer && !drawer.hidden) { singleton.context = contextFromRoute(global.frappe.get_route()); singleton.renderContext(); } else if (routeIsPage()) syncRouteSelection(); else singleton.hide(); };
		if (global.frappe.router && global.frappe.router.on) global.frappe.router.on("change", routeChange);
		syncDesk();
		if (global.frappe.realtime && global.frappe.realtime.on) global.frappe.realtime.on("intelligence_update", (event) => { if (!singleton || !event || !event.conversation) return; if (singleton.visible || singleton.watched.has(event.conversation)) { singleton.lastList = 0; singleton.poller.start(100); } });
		global.addEventListener("online", () => { if (singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
		global.document.addEventListener("visibilitychange", () => { if (!global.document.hidden && singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
		global.addEventListener("pagehide", () => { if (singleton) singleton.poller.stop(); });
		global.addEventListener("pageshow", () => { if (singleton && (singleton.visible || singleton.watched.size)) singleton.poller.start(0); });
	}
	return { install, showPage, syncDesk, toggle: openDrawer, close: closeDrawer, App, Poller, utils: { esc, safeURL, markdown, contextFromRoute, userError, previewHTML, actionSentence, recordLink, fileCardHTML, skillsHTML, learnedSkillsHTML, effortOptions, scopeState, scopeProblem, scopeHTML, stamp }, request };
});
