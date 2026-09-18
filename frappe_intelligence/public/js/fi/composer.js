/* Intelligence composer: draft, attachments, provider picker, send. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi;
	if (!fi) throw new Error("Intelligence core must load before composer");
	const { API, icon, esc, iconButton, App } = fi;
App.prototype.renderProviders = function () {
		const select = this.$('[data-input="provider"]'); const providers = this.boot && this.boot.providers || [];
		let options = providers.map((provider) => '<option value="' + esc(provider.name) + '">' + esc(provider.title + " · " + provider.model) + "</option>").join("");
		if (this.selected && !providers.some((provider) => provider.name === this.provider)) options += '<option value="' + esc(this.provider) + '">Provider unavailable</option>';
		if (select.dataset.options !== options) { select.innerHTML = options || '<option value="">Set up a provider</option>'; select.dataset.options = options; }
		select.value = this.provider;
		select.title = this.selected ? "This conversation uses its original provider. Start a new conversation to switch." : "Choose a configured provider and model";
	}
App.prototype.renderAttachments = function () {
		const signature = JSON.stringify([this.draft().attachments, this.pending.has("upload")]); if (signature === this.attachmentSignature) return; this.attachmentSignature = signature;
		this.slot("attachments").innerHTML = this.draft().attachments.map((file) => '<span class="fi-file-chip">' + icon("file") + "<span>" + esc(file.file_name) + "</span>" + iconButton("remove-file", "Remove " + file.file_name + " from this message", "close", 'data-name="' + esc(file.name) + '"') + "</span>").join("") + (this.pending.has("upload") ? '<span class="fi-file-chip"><span class="fi-spinner"></span>Uploading privately…</span>' : "");
	}
App.prototype.renderControls = function () {
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
App.prototype.syncDraft = function () { this.$("textarea").value = this.draft().text; this.resizeComposer(); this.renderAttachments(); this.renderControls(); }
App.prototype.resizeComposer = function () { const input = this.$("textarea"); input.style.height = "auto"; input.style.height = Math.min(180, Math.max(64, input.scrollHeight)) + "px"; }
App.prototype.ensureConversation = async function () {
		if (this.selected) return this.selected;
		const draft = this.draft(); const conversation = await this.api("create_conversation", { provider: this.provider });
		if (!conversation || !conversation.name) throw { userMessage: "The server did not return a conversation. Refresh before trying again." };
		this.selected = conversation.name; this.selectVersion++; this.drafts.set(conversation.name, draft); this.drafts.delete("new"); this.snapshot = { conversation, messages: [], approvals: [], files: [], run: null, can_post: true }; this.lastList = 0; this.navigate(conversation.name); this.render(); return conversation.name;
	}
App.prototype.send = function () {
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
App.prototype.chooseFile = function () {
		const input = this.doc.createElement("input"); input.type = "file"; input.accept = ".pdf,.txt,.csv,.md,.json,text/plain,text/csv,application/pdf";
		input.addEventListener("change", () => { const file = input.files && input.files[0]; if (file) this.upload(file); }); input.click();
	}
App.prototype.upload = function (file) {
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
});
