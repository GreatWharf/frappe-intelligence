/* Intelligence thread surface: messages, tool rows, approvals, markdown. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi;
	if (!fi) throw new Error("Intelligence core must load before thread");
	const { API, LOGO, icon, esc, request, button, time, stamp, parsed, dashed, lines, App } = fi;
	// Blocked markup never reaches the page, even as escaped text outside code
	// fences: the tags are removed line by line before rendering (fenced code
	// keeps its literal text, escaped as always).
	const BLOCKED_PAIR = /<(script|style|iframe|object|embed|form)\b[^>]*>[^]*?<\/\1\s*>/i;
	const BLOCKED_TAG = /<\/?(?:script|style|iframe|object|embed|form)\b[^>]*>/gi;
	const BLOCKED_OPEN = /<(script|style|iframe|object|embed|form)\b[^>]*>/i;
	function stripBlocked(line) {
		let text = String(line);
		while (BLOCKED_PAIR.test(text)) text = text.replace(BLOCKED_PAIR, "");
		return text.replace(BLOCKED_TAG, "");
	}
	// markdown() feeds one line at a time, so a blocked element whose open and
	// close tags sit on different lines needs state: once an opener without a
	// same-line close is seen, every line up to the closer is swallowed (null),
	// otherwise the element's body would leak into the transcript as text.
	function makeStripper() {
		let openTag = null;
		return (line) => {
			if (openTag) {
				const closeAt = line.toLowerCase().indexOf("</" + openTag);
				if (closeAt === -1) return null;
				const rest = line.slice(closeAt + openTag.length + 3);
				openTag = null;
				return stripBlocked(rest);
			}
			const open = String(line).match(BLOCKED_OPEN);
			if (open) {
				const tag = open[1].toLowerCase();
				if (line.toLowerCase().indexOf("</" + tag, open.index) === -1) {
					openTag = tag;
					return stripBlocked(String(line).slice(0, open.index));
				}
			}
			return stripBlocked(line);
		};
	}
	function safeURL(value) {
		const raw = String(value || "").trim();
		if (!raw || /[\x00-\x20\x7f\\]/.test(raw) || raw.startsWith("//")) return "";
		if (raw.startsWith("/")) {
			try { const local = new URL(raw, "https://intelligence.invalid"); return /^\/((?:app|desk)(?:\/|$)|private\/files\/|files\/|api\/method\/frappe\.)/.test(local.pathname) && !/%(?:00|0a|0d|5c)/i.test(raw) ? local.pathname + local.search + local.hash : ""; } catch (_) { return ""; }
		}
		// External targets (file cards) are https-only, matching the markdown rules.
		try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch (_) { return ""; }
	}
	// Markdown links are stricter than app-internal URLs: only https:, mailto:
	// and same-page fragments become anchors; anything else renders as text.
	function mdURL(value) {
		const raw = String(value || "").trim();
		if (!raw) return "";
		if (raw.startsWith("#")) return /^#[^\s"'<>\\]*$/.test(raw) ? raw : "";
		try { const url = new URL(raw); return (url.protocol === "https:" || url.protocol === "mailto:") && !url.username && !url.password ? url.href : ""; } catch (_) { return ""; }
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
			else { const link = token.match(/^\[([^\]]+)\]\(([^)]*)\)$/); const href = mdURL(link[2]); output += href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(link[1]) + "</a>" : esc(link[1]); }
			cursor = match.index + token.length;
		}
		return output + esc(text.slice(cursor));
	}
	function markdown(value) {
		const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
		let html = "", paragraph = [], list = "", code = null, lang = "";
		const strip = makeStripper();
		const flush = () => { if (paragraph.length) { html += "<p>" + paragraph.map(inline).join("<br>") + "</p>"; paragraph = []; } if (list) { html += "</" + list + ">"; list = ""; } };
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*```/.test(line)) {
				if (code !== null) { html += '<div class="fi-code"><div class="fi-code-head"><span>' + esc(lang || "Code") + '</span><button type="button" data-action="copy-code">Copy</button></div><pre><code>' + esc(code.join("\n")) + "</code></pre></div>"; code = null; }
				else { flush(); code = []; lang = line.trim().slice(3).trim(); } continue;
			}
			if (code !== null) { code.push(line); continue; }
			const clean = strip(line);
			if (clean === null) continue;
			if (!clean.trim()) { flush(); continue; }
			const heading = clean.match(/^(#{1,3})\s+(.+)$/);
			if (heading) { flush(); const level = heading[1].length + 2; html += "<h" + level + ">" + inline(heading[2]) + "</h" + level + ">"; continue; }
			if (clean.includes("|") && i + 1 < lines.length && code === null && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(stripBlocked(lines[i + 1]))) {
				flush(); const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
				html += '<div class="fi-table-wrap"><table><thead><tr>' + cells(clean).map((cell) => "<th>" + inline(cell) + "</th>").join("") + "</tr></thead><tbody>"; i++;
				while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) html += "<tr>" + cells(stripBlocked(lines[++i])).map((cell) => "<td>" + inline(cell) + "</td>").join("") + "</tr>";
				html += "</tbody></table></div>"; continue;
			}
			const item = clean.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
			if (item) { const type = item[1] ? "ul" : "ol"; if (paragraph.length || (list && list !== type)) flush(); if (!list) { list = type; html += "<" + type + ">"; } html += "<li>" + inline(item[2]) + "</li>"; continue; }
			if (list) flush();
			if (/^>\s?/.test(clean)) { flush(); html += "<blockquote>" + inline(clean.replace(/^>\s?/, "")) + "</blockquote>"; } else paragraph.push(clean);
		}
		flush(); if (code !== null) html += '<div class="fi-code"><pre><code>' + esc(code.join("\n")) + "</code></pre></div>";
		return html;
	}
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
	const GERUNDS = { Search: "Searching", Read: "Reading", Create: "Creating", Update: "Updating", Delete: "Deleting", Submit: "Submitting", Cancel: "Cancelling", Run: "Running" };
	function gerund(sentence) { return String(sentence || "").replace(/^(Search|Read|Create|Update|Delete|Submit|Cancel|Run)\b/, (verb) => GERUNDS[verb]); }
	function isDestructive(preview, toolName) {
		const data = previewData(preview);
		return String(data.operation || "").toLowerCase() === "delete" || /delete|remove|drop|destroy/.test(String(toolName || "").toLowerCase());
	}
	// Auto-approved steps arrive with a blank decided_by and a policy:/grant:
	// source. Payloads without those fields (pre-integration) render as now.
	function isAutoApproved(approval) {
		return !!approval && approval.status !== "pending" && approval.decided_by === "" && typeof approval.source === "string" && !!approval.source;
	}
	function autoTag(source) { return "Auto-approved by " + (String(source).split(":")[0] === "grant" ? "grant" : "policy"); }
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
	function changeTableHTML(changes) {
		// Structured before/after values stay behind a details toggle; the table cells
		// show a compact label instead of raw JSON.
		const value = (entry) => {
			if (entry == null) return "-";
			if (typeof entry !== "object") return esc(String(entry));
			const label = Array.isArray(entry) ? entry.length + " item" + (entry.length === 1 ? "" : "s") : Object.keys(entry).length + " field" + (Object.keys(entry).length === 1 ? "" : "s");
			return '<details class="fi-change-value"><summary>' + esc(label) + "</summary><pre>" + esc(JSON.stringify(entry, null, 2)) + "</pre></details>";
		};
		return '<div class="fi-change-table"><table><thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead><tbody>' + changes.map((change) => "<tr><th>" + esc(change.label || change.field) + "</th><td>" + value(change.before) + "</td><td>" + value(change.after) + "</td></tr>").join("") + "</tbody></table></div>";
	}
	function previewHTML(preview) {
		const data = previewData(preview);
		const summary = data.summary || data.description || "";
		let html = summary ? '<p class="fi-approval-summary">' + esc(summary) + "</p>" : "";
		if (Array.isArray(data.changes) && data.changes.length) html += changeTableHTML(data.changes);
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
	function rowContext(approval) {
		const data = previewData(approval.preview);
		if (isFileAction(data)) return fileChip(data);
		const target = data.target && typeof data.target === "object" ? data.target : {};
		const doctype = data.doctype || target.doctype || "";
		const name = data.name || target.name || "";
		if (doctype) return esc(doctype + (name ? " / " + name : ""));
		return esc(String(approval.tool_name || "").replace(/[_-]+/g, " "));
	}
	const ALERT_ICON = '<svg class="fi-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Zm0 7v4m0 3v1"/></svg>';
	function statusCell(status) {
		if (["approved", "executing"].includes(status)) return '<span class="fi-spinner" role="status" aria-label="Working"></span>';
		if (status === "succeeded") return '<span class="fi-tool-done" role="img" aria-label="Done">' + icon("check") + '</span>';
		if (status === "failed" || status === "denied") return '<span class="fi-tool-failed" role="img" aria-label="' + (status === "denied" ? "Denied" : "Failed") + '">' + icon("close") + '</span>';
		return '<span class="fi-tool-note" role="img" aria-label="Note">' + icon("info") + "</span>";
	}
App.prototype.thinkingHTML = function () {
		return '<div class="fi-thinking" role="status" aria-label="Intelligence is working"><span class="fi-avatar fi-avatar-ai"><img class="fi-avatar-logo" src="' + LOGO + '" alt=""></span><span class="fi-thinking-dots"><i></i><i></i><i></i></span></div>';
	}
App.prototype.renderMessages = function () {
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
			slot.innerHTML = '<div class="fi-welcome"><div class="fi-welcome-symbol" aria-hidden="true"><img class="fi-welcome-logo" src="' + LOGO + '" alt=""></div><h2>' + greeting + '</h2><p>Ask about your business. Find the right records.<br>Take the next step, with you in control.</p>' + (noProviders ? '<div class="fi-setup-note"><strong>Connect a provider to get started</strong><p>Use your own API key and choose the model that works for you.</p>' + button("providers-list", "Set up a provider", "plus", "fi-primary") + "</div>" : '<div class="fi-starters"><button type="button" data-action="starter" data-prompt="Give me my briefing for today: what needs my attention across my companies, invoices, emails and tasks?"><span class="fi-starter-icon">' + icon("sun") + '</span><strong>Today&rsquo;s briefing</strong><span>What needs your attention right now</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Help me find the records I need to review today."><span class="fi-starter-icon">' + icon("search") + '</span><strong>Find what matters</strong><span>Explore records you can access</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Help me understand this workflow before making any changes."><span class="fi-starter-icon">' + icon("chat") + '</span><strong>Think it through</strong><span>Understand a process or next step</span>' + icon("chevron") + '</button><button type="button" data-action="starter" data-prompt="Review an attached document and help me identify the next steps."><span class="fi-starter-icon">' + icon("file") + '</span><strong>Start with a document</strong><span>Work with a private PDF or text file</span>' + icon("chevron") + "</button></div>") + '<div class="fi-welcome-foot">' + icon("lock") + " Private conversations. Explicit approvals. Your permissions.</div></div>";
		} else {
			// Merge messages and tool rows into one chronological feed: rows
			// grouped after all messages would bury the final answer mid-thread.
			const canPost = !this.readOnly();
			const run = this.snapshot && this.snapshot.run;
			const pending = approvals.filter((approval) => approval.status === "pending");
			const bulk = pending.length > 1;
			let bulkDone = false;
			const feed = messages.filter((message) => ["user", "assistant"].includes(message.role) && message.content).map((message) => ({ creation: message.creation || "", type: "message", html: this.messageHTML(message) })).concat(approvals.map((approval) => ({ creation: approval.creation || "", type: "approval", approval }))).sort((a, b) => (a.creation < b.creation ? -1 : a.creation > b.creation ? 1 : 0));
			// Consecutive sealed tool rows collapse into one group; a pending
			// approval always breaks the group and stays fully visible.
			let body = "", group = [];
			const flush = () => { if (group.length) { body += group.length > 1 ? this.toolGroupHTML(group, canPost) : this.toolRowHTML(group[0], canPost); group = []; } };
			for (const entry of feed) {
				if (entry.type === "approval") {
					if (entry.approval.status === "pending") {
						flush();
						if (bulk) { if (!bulkDone) { body += this.approvalGroupHTML(pending, canPost); bulkDone = true; } }
						else body += this.approvalHTML(entry.approval, canPost);
						continue;
					}
					group.push(entry.approval); continue;
				}
				flush(); body += entry.html;
			}
			flush();
			const thinking = run && ["queued", "running"].includes(run.state) ? this.thinkingHTML() : "";
			const selected = new Set(this.draft().attachments.map((file) => file.name));
			const fileCards = files.length ? '<div class="fi-file-cards" role="group" aria-label="Conversation files">' + files.map((file) => fileCardHTML(file, canPost && !selected.has(file.name) ? { attach: true, attachLabel: "Attach" } : canPost ? { attach: true, attachLabel: "Attached" } : null)).join("") + "</div>" : "";
			slot.innerHTML = (this.snapshot.has_earlier_messages ? '<div class="fi-history-more">' + button("earlier", "Load earlier messages", "retry", "fi-text-btn") + "</div>" : "") + '<div class="fi-thread-start">' + icon("lock") + (this.snapshot.conversation && Number(this.snapshot.conversation.shared) ? " This conversation is shared read only" : " This conversation is private to you") + "</div>" + body + thinking + fileCards;
			this.bindFileCards(slot);
		}
		if (nearBottom || !this.snapshot || this.snapshot.messages && this.snapshot.messages.length < 2) thread.scrollTop = thread.scrollHeight;
		this.syncScrollButton();
	}
App.prototype.syncScrollButton = function () {
		const thread = this.slot("thread"), trigger = this.$('[data-action="scroll-bottom"]');
		if (!thread || !trigger) return;
		trigger.hidden = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
	}
App.prototype.toolGroupHTML = function (list, canPost) {
		const key = list.map((approval) => approval.name).join("|"), open = this.expandedTools.has(key);
		const active = list.find((approval) => ["approved", "executing"].includes(approval.status));
		const title = active ? gerund(actionSentence(active.preview, active.tool_name)) : "Used " + list.length + " tools";
		return '<section class="fi-tool-group' + (open ? " is-open" : "") + (active ? " is-active" : "") + '" aria-label="Tool actions"><button type="button" class="fi-tool-group-head" data-action="toggle-tools" data-key="' + esc(key) + '" aria-expanded="' + String(open) + '"><span class="fi-tool-group-icon">' + icon("wrench") + '</span><span class="fi-tool-group-title' + (active ? " fi-shimmer" : "") + '">' + esc(title) + '</span>' + (active ? '<span class="fi-spinner fi-tool-group-spinner" role="status" aria-label="Working"></span>' : "") + '<span class="fi-tool-group-chevron">' + icon("chevron") + "</span></button>" + '<div class="fi-tool-group-body"' + (open ? "" : " hidden") + ">" + list.map((approval) => this.toolRowHTML(approval, canPost)).join("") + '<details class="fi-proposal fi-group-details"><summary>Technical details</summary><pre>' + esc(JSON.stringify(list.map((approval) => ({ tool: approval.tool_name, status: approval.status, preview: previewData(approval.preview) })), null, 2)) + "</pre></details></div></section>";
	}
App.prototype.toolRowHTML = function (approval, canPost) {
		const status = String(approval.status || "pending");
		const sentence = actionSentence(approval.preview, approval.tool_name);
		const auto = isAutoApproved(approval);
		const key = "tool:" + approval.name, open = this.expandedTools.has(key);
		// The row button's aria-label masks its inner spans, so the status word
		// rides along in the label itself.
		const statusWord = { approved: "working", executing: "working", succeeded: "done", failed: "failed", denied: "denied" }[status];
		return '<div class="fi-tool-block' + (open ? " is-open" : "") + (auto ? " fi-tool-auto" : "") + '">'
			+ '<button type="button" class="fi-tool-row" data-action="toggle-tool" data-key="' + esc(key) + '" aria-expanded="' + String(open) + '" aria-label="' + esc(sentence + (statusWord ? ", " + statusWord : "")) + '">'
			+ '<span class="fi-tool-status">' + statusCell(status) + '</span>'
			+ '<span class="fi-tool-label">' + esc(gerund(sentence)) + '</span>'
			+ '<span class="fi-tool-context">' + rowContext(approval) + '</span>'
			+ (isDestructive(approval.preview, approval.tool_name) ? '<span class="fi-tool-alert" title="This action can delete data">' + ALERT_ICON + "</span>" : "")
			+ (auto ? '<span class="fi-tool-tag">' + esc(autoTag(approval.source)) + "</span>" : "")
			+ '<span class="fi-tool-chevron">' + icon("chevron") + "</span></button>"
			+ '<div class="fi-tool-detail"' + (open ? "" : " hidden") + ">" + this.toolDetailHTML(approval) + "</div></div>";
	}
App.prototype.toolDetailHTML = function (approval) {
		const data = previewData(approval.preview);
		const sentence = actionSentence(approval.preview, approval.tool_name);
		const summary = data.summary || data.description || "";
		let html = summary && summary !== sentence ? '<p class="fi-tool-summary">' + esc(summary) + "</p>" : "";
		if (Array.isArray(data.changes) && data.changes.length) html += changeTableHTML(data.changes);
		const details = data.details && typeof data.details === "object" && !Array.isArray(data.details) ? data.details : null;
		if (details && Object.keys(details).length) {
			const cell = (value) => {
				if (value == null) return { text: "-", long: false, code: false };
				if (typeof value === "object") return { text: JSON.stringify(value, null, 2), long: true, code: true };
				const text = String(value);
				return { text, long: text.length > 80 || text.includes("\n"), code: text.includes("\n") };
			};
			html += '<dl class="fi-tool-args">' + Object.entries(details).map(([key, value]) => {
				const entry = cell(value);
				return '<div class="fi-tool-arg' + (entry.long ? " fi-tool-arg-full" : "") + '"><dt>' + esc(key) + "</dt><dd>" + (entry.code ? "<pre>" + esc(entry.text) + "</pre>" : esc(entry.text)) + "</dd></div>";
			}).join("") + "</dl>";
		}
		if (!isFileAction(data)) { const link = recordLink(approval.preview); if (link) html += '<div class="fi-approval-link">' + link + "</div>"; }
		const error = typeof approval.error === "string" && approval.error || typeof data.error === "string" && data.error || "";
		if (error) html += '<div class="fi-tool-error" role="alert">' + esc(error) + "</div>";
		html += '<details class="fi-proposal fi-tool-raw"><summary>Technical details</summary><pre>' + esc(JSON.stringify({ tool: approval.tool_name, status: approval.status, preview: data }, null, 2)) + "</pre></details>";
		return html;
	}
	// Row expansion, via the entry action seam (data-action="toggle-tool").
App.prototype["action_toggle-tool"] = function (target) {
		const block = target.closest(".fi-tool-block"), detail = block && block.querySelector(".fi-tool-detail");
		if (!detail) return;
		const open = detail.hidden; detail.hidden = !open; block.classList.toggle("is-open", open); target.setAttribute("aria-expanded", String(open));
		if (open) this.expandedTools.add(target.dataset.key); else this.expandedTools.delete(target.dataset.key);
		this.syncScrollButton();
	}
App.prototype.bindFileCards = function (slot) {
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
App.prototype.messageHTML = function (message) {
		// User messages are plain text in a right-aligned bubble; assistant prose
		// stays full-width markdown so tables and code keep their room.
		const user = message.role === "user";
		return '<article class="fi-message fi-message-' + esc(message.role) + '" data-message="' + esc(message.name) + '"><div class="fi-message-heading"><span class="fi-avatar ' + (message.role === "assistant" ? "fi-avatar-ai" : "") + '">' + (message.role === "assistant" ? '<img class="fi-avatar-logo" src="' + LOGO + '" alt="">' : "Y") + "</span><strong>" + (message.role === "assistant" ? "Intelligence" : "You") + "</strong><span>" + esc(time(message.creation)) + "</span>" + (message.status === "interrupted" ? '<span class="fi-message-interrupted">Interrupted</span>' : "") + '</div><div class="fi-message-content">' + (user ? esc(message.content) : markdown(message.content)) + "</div></article>";
	}
App.prototype.approvalHTML = function (approval, canPost) {
		const pending = approval.status === "pending", locked = this.pending.has("approval:" + approval.name);
		const status = String(approval.status || "pending");
		const sentence = actionSentence(approval.preview, approval.tool_name);
		const link = recordLink(approval.preview);
		const decisions = pending && canPost !== false && canPost !== 0;
		return '<section class="fi-approval ' + (pending ? "is-pending" : "") + '" aria-label="Tool action"><div class="fi-approval-top"><span class="fi-approval-icon">' + icon(pending ? "lock" : "check") + '</span><div><span class="fi-eyebrow">' + (pending ? "YOUR APPROVAL IS REQUIRED" : "TOOL ACTION") + "</span><h3>" + esc(sentence) + "</h3>" + (link ? '<div class="fi-approval-link">' + link + "</div>" : "") + '</div><span class="fi-pill fi-pill-' + esc(status) + '">' + esc(status) + "</span></div>" + previewHTML(approval.preview) + (approval.expires_at && pending ? '<p class="fi-approval-expiry">Expires ' + esc(approval.expires_at) + "</p>" : "") + (pending ? (decisions ? '<div class="fi-approval-footer"><span>Nothing runs until you approve.</span><div>' + button("deny", "Deny", null, "", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + button("approve", "Approve action", "check", "fi-primary", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + button("always", "Always allow", null, "fi-text-btn", 'data-name="' + esc(approval.name) + '" title="Approve now and stop asking for this action (applies to every conversation)" ' + (locked ? "disabled" : "")) + button("conversation", "For this conversation", null, "fi-text-btn", 'data-name="' + esc(approval.name) + '" title="Approve now and stop asking for this action in this conversation only" ' + (locked ? "disabled" : "")) + "</div></div>" : '<div class="fi-approval-result">Waiting for the owner to decide.</div>') : '<div class="fi-approval-result">' + esc({ approved: "Approved; waiting for execution.", denied: "Denied. This request will not run.", executing: "Executing the approved request.", succeeded: "The approved action completed.", failed: "The action failed. Check the run status.", expired: "This approval expired. Start a new request if it is still needed.", uncertain: "The result could not be confirmed. Check the record before trying again." }[status] || "") + "</div>") + "</section>";
	}
App.prototype.approvalGroupHTML = function (list, canPost) {
		const decisions = canPost !== false && canPost !== 0;
		const rows = list.map((approval) => {
			const locked = this.pending.has("approval:" + approval.name);
			return '<div class="fi-bulk-row" data-approval="' + esc(approval.name) + '"><span class="fi-tool-status">' + icon("lock") + '</span><span class="fi-bulk-summary">' + esc(actionSentence(approval.preview, approval.tool_name)) + '</span>' + (decisions ? '<span class="fi-bulk-actions">' + button("deny", "Deny", null, "", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + button("approve", "Approve", "check", "fi-primary", 'data-name="' + esc(approval.name) + '" ' + (locked ? "disabled" : "")) + "</span>" : "") + "</div>";
		}).join("");
		return '<section class="fi-approval fi-approval-bulk is-pending" aria-label="Pending approvals"><div class="fi-approval-top"><span class="fi-approval-icon">' + icon("lock") + '</span><div><span class="fi-eyebrow">YOUR APPROVAL IS REQUIRED</span><h3>' + list.length + " actions need your approval</h3></div>" + '<span class="fi-pill fi-pill-pending">pending</span></div><div class="fi-bulk-rows">' + rows + "</div>" + (decisions ? '<label class="fi-bulk-remember"><input type="checkbox" data-input="bulk-remember"><span>Remember each choice for this conversation</span></label><div class="fi-approval-footer"><span>Nothing runs until you approve.</span><div>' + button("deny-all", "Deny all", null, "", "") + button("approve-all", "Approve all " + list.length, "check", "fi-primary", "") + "</div></div>" : '<div class="fi-approval-result">Waiting for the owner to decide.</div>') + "</section>";
	}
	// New approval actions, reached through the entry action seam.
App.prototype.action_conversation = function (target) {
		const name = this.selected;
		return this.busy("approval:" + target.dataset.name, async () => {
			await this.api("approve", { approval: target.dataset.name, decision: "always", scope: "This Conversation" });
			this.notice = "Approved. This action will not ask again in this conversation."; this.renderBanner();
			this.accept(name, await this.fetchConversation(name)); this.poller.start(0);
		});
	}
App.prototype.decideBulk = function (target, approve) {
		const card = target.closest(".fi-approval-bulk");
		const names = (this.snapshot && this.snapshot.approvals || []).filter((approval) => approval.status === "pending").map((approval) => approval.name);
		if (!names.length) return Promise.resolve();
		// One-off bulk decisions use decision approve/deny, which never records a
		// grant server-side. The checkbox upgrades an approve to a
		// conversation-scoped grant; denies have no grant form, so the checkbox
		// never changes a deny.
		const remember = !!(approve && card && card.querySelector('[data-input="bulk-remember"]') && card.querySelector('[data-input="bulk-remember"]').checked);
		const args = { names: JSON.stringify(names), decision: approve ? (remember ? "always" : "approve") : "deny" };
		if (remember) args.scope = "This Conversation";
		const name = this.selected;
		return this.busy("approvals:bulk", async () => {
			await this.api("decide_approvals", args);
			if (remember) { this.notice = "Approved. These actions will not ask again in this conversation."; this.renderBanner(); }
			this.accept(name, await this.fetchConversation(name)); this.poller.start(0);
		});
	}
App.prototype["action_approve-all"] = function (target) { return this.decideBulk(target, true); }
App.prototype["action_deny-all"] = function (target) { return this.decideBulk(target, false); }
	Object.assign(fi, { safeURL, mdURL, inline, markdown, previewData, fileNameOf, isFileAction, actionSentence, gerund, isDestructive, isAutoApproved, autoTag, fileChip, recordLink, toolIcon, previewHTML, fileCardHTML, stripBlocked });
	Object.assign(fi.utils, { safeURL, markdown, previewHTML, actionSentence, recordLink, fileCardHTML, mdURL, gerund, isAutoApproved });
});
