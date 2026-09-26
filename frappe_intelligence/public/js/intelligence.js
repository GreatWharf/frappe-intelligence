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
	const EFFORTS = ["Auto", "Low", "Medium", "High", "Max"];
	const LABELS = { queued: "Queued", running: "Working", awaiting_approval: "Needs your approval", completed: "Completed", failed: "Run failed", cancelled: "Cancelled", needs_reconciliation: "Needs review" };
	const PAGE = "intelligence";
	const icons = {
		plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
		chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2V12a9 9 0 0 1 18-.5Z"/>',
		close: '<path d="m6 6 12 12M6 18 18 6"/>', arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
		chevron: '<path d="m9 5 7 7-7 7"/>', down: '<path d="m6 9 6 6 6-6"/>',
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
		wrench: '<path d="M14.5 6.5a4.2 4.2 0 0 1 5.6-4L17.5 5l1.5 1.5 2.6-2.6a4.2 4.2 0 0 1-5.7 5.6L7.6 18.7a2 2 0 0 1-2.9-2.9l8.2-8.2a4.2 4.2 0 0 1 1.6-1.1Z"/>'
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
	function lines(value) { return Array.from(new Set(String(value || "").split("\n").map((line) => line.trim()).filter(Boolean))); }
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
		hide() { this.visible = false; this.poller.stop(); if (this.watched.size) this.poller.start(1000); }
		// Desk page bodies are not height-constrained, so an unpinned app grows
		// with its content and the whole Desk document scrolls next to the
		// thread's own scrollbar. Measure the app's own rect (never
		// documentElement.scrollHeight) and pin it to the remaining viewport in
		// page mode, so the header and composer stay put and only the thread
		// scrolls. Drawer mode is a fixed overlay; CSS owns its height.
		fitViewport() {
			if (!this.root.isConnected || typeof this.root.getBoundingClientRect !== "function") return;
			this.root.style.height = "";
			if (this.mode !== "page") return;
			const viewport = Number(global.innerHeight) || 0;
			if (!viewport) return;
			const rect = this.root.getBoundingClientRect();
			const available = Math.floor(viewport - rect.top - 8);
			if (available >= 320) this.root.style.height = available + "px";
		}
		// On a hard reload Desk chrome is still laying out when show() measures, so
		// the pin never applies and the whole document grows instead of the thread
		// scrolling. Re-measure on the next frame and after each async load settles.
		refitViewport() { if (global.requestAnimationFrame) global.requestAnimationFrame(() => this.fitViewport()); }
		async refreshList() {
			const version = ++this.listVersion;
			const rows = await this.api("list_conversations", { archived: this.archived ? 1 : 0 });
			if (version !== this.listVersion) return;
			this.conversations = Array.isArray(rows) ? rows : [];
			// Keep the native Desk sidebar's Recent chats section in step with
			// every list refresh (renames, archives, new chats) without an extra fetch.
			if (fi.deskSidebar && typeof fi.deskSidebar.sync === "function") fi.deskSidebar.sync(this.conversations);
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
			// The subtitle carries access state only; the provider and model live
			// in the composer pickers, not in the header.
			let subtitle;
			if (this.snapshot && Number(this.snapshot.conversation.archived)) subtitle = "Archived · read only";
			else if (this.snapshot && this.snapshot.can_post === false) subtitle = "Shared by " + (this.snapshot.conversation.owner || "another user") + " · read only";
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
			// The banner takes layout space inside the pinned app; re-measure so
			// the page-mode pin tracks the remaining viewport.
			this.refitViewport();
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
			// The no-providers welcome CTA goes to the native provider page.
			if (action === "providers-list") { if (global.frappe && global.frappe.set_route) global.frappe.set_route("List", "Intelligence Provider"); return; }
			if (action === "starter") { this.draft().text = target.dataset.prompt; this.syncDraft(); this.$("textarea").focus(); return; }
			if (action === "remove-context") { this.context = null; this.renderContext(); return; }
			if (action === "remove-file") { this.draft().attachments = this.draft().attachments.filter((file) => file.name !== target.dataset.name); this.renderAttachments(); this.messageSignature = ""; this.renderMessages(); return; }
			if (action === "dismiss") { this.error = ""; this.notice = ""; this.renderBanner(); return; }
			if (action === "refresh") return this.refresh();
			if (action === "earlier") return this.loadEarlier();
			if (action === "close") return this.onClose && this.onClose();
			if (action === "expand") return this.onExpand && this.onExpand();
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
				? '<ul class="fi-share-list">' + shares.map((row) => '<li class="fi-share-row"><span class="fi-share-user"><strong>' + esc(row.full_name || row.user) + "</strong><span>" + esc(row.user) + "</span></span>" + iconButton("unshare-user", "Stop sharing with " + (row.full_name || row.user), "close", 'data-user="' + esc(row.user) + '"') + "</li>").join("") + "</ul>"
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
	}
	function trapFocus(event, container) {
		const nodes = Array.from(container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter((node) => !node.closest("[hidden]") && (node.getClientRects ? node.getClientRects().length : true));
		if (!nodes.length) { event.preventDefault(); return; } const first = nodes[0], last = nodes[nodes.length - 1];
		if (event.shiftKey && (global.document.activeElement === first || !container.contains(global.document.activeElement))) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && (global.document.activeElement === last || !container.contains(global.document.activeElement))) { event.preventDefault(); first.focus(); }
	}
	Object.assign(fi, { API, LOGO, ACTIVE, EFFORTS, LABELS, PAGE, icons, icon, esc, contextFromRoute, userError, request, button, iconButton, time, stamp, parsed, dashed, lines, mergeMessages, App, trapFocus });
	fi.utils = { esc, contextFromRoute, userError, stamp };
	return fi;
});
