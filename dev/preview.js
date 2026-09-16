/* Explicit mock of the documented API contract. No external network calls or real records. */
(function () {
  'use strict';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const scene = new URLSearchParams(location.search).get('scene') || 'empty';
  const timestamp = '2026-09-16 10:24:00';
  const providers = [{ name: 'provider-1', title: 'Work account', kind: 'OpenAI', model: 'gpt-4.1', enabled: 1, is_shared: 0, has_api_key: true, can_edit: true }];
  const conversations = [
    { name: 'chat-1', title: 'Review outstanding sales orders', provider: 'provider-1', modified: timestamp, active_run: scene === 'approval' ? 'run-1' : null, archived: 0 },
    { name: 'chat-2', title: 'A clearer month-end checklist', provider: 'provider-1', modified: '2026-09-15 15:12:00', archived: 0 },
    { name: 'chat-3', title: 'Understand our delivery workflow', provider: 'provider-1', modified: '2026-09-14 10:11:00', archived: 0 },
    { name: 'chat-4', title: 'Notes from the supplier review', provider: 'provider-1', modified: '2026-09-12 09:45:00', archived: 0 }
  ];
  const snapshots = {};
  for (const row of conversations) snapshots[row.name] = { conversation: row, messages: [], approvals: [], files: [], run: null };
  snapshots['chat-1'].messages = [
    { name: 'message-1', role: 'user', content: 'Which sales orders are still waiting to be delivered? Help me see what needs attention this week.', status: 'complete', creation: timestamp },
    { name: 'message-2', role: 'assistant', content: 'I can look for open sales orders and compare their delivery dates.\n\nI’ll start with a **read-only search** for submitted orders that are not fully delivered. I’ll only see the records your account is allowed to access.\n\nPlease review the request below before I continue.', status: 'complete', creation: timestamp }
  ];
  if (scene === 'approval') {
    snapshots['chat-1'].run = { name: 'run-1', state: 'awaiting_approval', step_count: 1 };
    snapshots['chat-1'].approvals = [{ name: 'approval-1', tool_name: 'search_records', status: 'pending', expires_at: '2026-09-17 10:24:00', preview: { summary: 'Find submitted sales orders that still have items to deliver.', operation: 'Read records', target: { doctype: 'Sales Order' }, details: { fields: ['name', 'customer', 'delivery_date', 'per_delivered'], filters: { docstatus: 1, per_delivered: ['<', 100] }, limit: 20 } } }];
  }
  const memories = [{ name: 'memory-1', scope: 'personal', content: 'Use a Monday-to-Sunday week when reviewing delivery schedules.' }];
  const handlers = {};
  let sequence = 10, route = ['intelligence'];
  const preview = window.preview = { scene, calls: [], offline: false, providers, conversations, snapshots, memories, emit: (event) => (handlers.intelligence_update || []).forEach((callback) => callback(event)) };
  function changed(snapshot) { preview.emit({ conversation: snapshot.conversation.name, run: snapshot.run && snapshot.run.name, state: snapshot.run && snapshot.run.state }); }
  function finish(snapshot, state, text) {
    if (snapshot.run.state === 'cancelled') return;
    snapshot.run.state = state; snapshot.conversation.active_run = null;
    if (text) snapshot.messages.push({ name: 'message-' + (++sequence), role: 'assistant', content: text, status: 'complete', creation: timestamp });
    changed(snapshot);
  }
  async function api(method, args) {
    if (preview.offline) throw { userMessage: 'Preview connection interrupted.' };
    preview.calls.push({ method, args: clone(args || {}) });
    await new Promise((resolve) => setTimeout(resolve, 90));
    const snapshot = snapshots[args.conversation];
    switch (method) {
      case 'bootstrap': return { enabled: true, user: 'jamie@example.invalid', is_manager: true, providers: providers.filter((row) => row.enabled), managed_providers: providers, capabilities: { attachments: true, memory: true, shared_memory: true, provider_management: true, streaming: false }, defaults: { max_upload_mb: 10, approval_expiry_minutes: 1440 } };
      case 'list_conversations': return conversations.filter((row) => Number(row.archived || 0) === Number(args.archived || 0) && row.title.toLowerCase().includes((args.search || '').toLowerCase()));
      case 'get_conversation': if (!snapshot) throw { userMessage: 'Conversation not found.' }; return snapshot;
      case 'create_conversation': {
        const conversation = { name: 'chat-' + (++sequence), title: args.title || 'New conversation', provider: args.provider, modified: timestamp, archived: 0 };
        conversations.unshift(conversation); snapshots[conversation.name] = { conversation, messages: [], approvals: [], files: [], run: null }; return conversation;
      }
      case 'send_message': {
        if (snapshot.run && ['running', 'queued', 'awaiting_approval'].includes(snapshot.run.state)) throw { userMessage: 'This conversation already has an active run.' };
        snapshot.messages.push({ name: 'message-' + (++sequence), role: 'user', content: args.content, status: 'complete', creation: timestamp });
        snapshot.run = { name: 'run-' + (++sequence), state: 'running', step_count: 1 }; snapshot.conversation.active_run = snapshot.run.name;
        setTimeout(() => {
          if (snapshot.run.state !== 'running') return;
          snapshot.run.state = 'awaiting_approval';
          snapshot.messages.push({ name: 'message-' + (++sequence), role: 'assistant', content: '**Mock preview response.** I can help by reading the relevant records. Review this example request before continuing; no actual records will be accessed in this preview.', status: 'complete', creation: timestamp });
          snapshot.approvals.push({ name: 'approval-' + (++sequence), tool_name: 'search_records', status: 'pending', preview: { summary: 'Example: read a small set of permitted customer records.', operation: 'Read records', target: { doctype: 'Customer' }, details: { fields: ['name', 'customer_name'], limit: 5 } } }); changed(snapshot);
        }, 900); return snapshot.run;
      }
      case 'approve': {
        const match = Object.values(snapshots).find((row) => row.approvals.some((approval) => approval.name === args.approval));
        const approval = match.approvals.find((row) => row.name === args.approval); approval.status = args.decision === 'approve' ? 'approved' : 'denied'; match.run.state = 'running'; changed(match);
        setTimeout(() => {
          if (args.decision === 'approve') approval.status = 'succeeded';
          finish(match, 'completed', args.decision === 'approve' ? '### Review complete\n\nThis is **fictional preview data**, not a live report. Your approved request completed in the mock host.\n\n| Order | Customer | Delivery |\n| --- | --- | --- |\n| SO-DEMO-1042 | Northstar Components | 18 Sep |\n| SO-DEMO-1048 | Fieldwork Supply | 21 Sep |\n\nNo records were changed. You can ask a follow-up question or leave this conversation and return later.' : 'The request was denied. No records were read or changed.');
        }, 750); return match.run;
      }
      case 'cancel': {
        const match = Object.values(snapshots).find((row) => row.run && row.run.name === args.run); match.run.state = 'cancelled'; match.conversation.active_run = null; changed(match); return match.run;
      }
      case 'rename_conversation': snapshot.conversation.title = args.title; return snapshot.conversation;
      case 'archive_conversation': snapshot.conversation.archived = args.archived; return snapshot.conversation;
      case 'provider_details': return providers.find((row) => row.name === args.name);
      case 'save_provider': {
        let provider = providers.find((row) => row.name === args.name); if (!provider) { provider = { name: 'provider-' + (++sequence) }; providers.push(provider); }
        Object.assign(provider, { title: args.title, kind: args.kind, model: args.model, base_url: args.base_url, enabled: args.enabled, is_shared: args.is_shared, has_api_key: true, can_edit: true }); return provider;
      }
      case 'delete_provider': { const index = providers.findIndex((row) => row.name === args.name); providers.splice(index, 1); return { deleted: true }; }
      case 'list_memories': return memories.filter((row) => row.scope === args.scope && (args.scope !== 'conversation' || row.conversation === args.conversation));
      case 'save_memory': { let memory = memories.find((row) => row.name === args.name); if (!memory) { memory = { name: 'memory-' + (++sequence) }; memories.push(memory); } Object.assign(memory, { content: args.content, scope: args.scope, conversation: args.conversation }); return memory; }
      case 'delete_memory': { const index = memories.findIndex((row) => row.name === args.name); memories.splice(index, 1); return { deleted: true }; }
      default: throw { userMessage: 'No mock exists for ' + method };
    }
  }
  window.__ = (text) => text;
  window.frappe = {
    boot: {}, session: { user: 'jamie@example.invalid' }, csrf_token: 'mock-not-a-real-token',
    pages: { intelligence: {} }, get_route: () => route,
    set_route: (...parts) => { route = parts; (handlers.route || []).forEach((callback) => callback()); if (parts[0] === 'intelligence') { document.querySelector('#page').hidden = false; document.querySelector('#record').hidden = true; frappe.pages.intelligence.on_page_show(document.querySelector('#page')); } },
    router: { on: (_event, callback) => { (handlers.route ||= []).push(callback); } },
    realtime: { on: (event, callback) => { (handlers[event] ||= []).push(callback); } },
    ui: { make_app_page: ({ parent }) => ({ main: [parent] }) },
    call: ({ method, args, callback, error }) => api(method.replace('frappe_intelligence.api.', ''), args || {}).then((data) => { callback({ message: clone(data) }); }).catch((failure) => { error(failure); })
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (url, options) => {
    if (String(url).endsWith('frappe_intelligence.api.upload_attachment')) {
      preview.calls.push({ method: 'upload_attachment', args: { conversation: options.body.get('conversation') } });
      const file = options.body.get('file'); const attachment = { name: 'file-' + (++sequence), file_name: file.name, file_url: '/private/files/' + encodeURIComponent(file.name), is_private: 1 };
      snapshots[options.body.get('conversation')].files.push(attachment);
      return new Response(JSON.stringify({ message: attachment }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
})();
