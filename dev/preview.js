/* Explicit mock of the documented API contract. No external network calls or real records. */
(function () {
  'use strict';
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const scene = new URLSearchParams(location.search).get('scene') || 'empty';
  const timestamp = '2026-09-16 10:24:00';
  const providers = [
    { name: 'provider-1', title: 'Work account', kind: 'OpenAI', model: 'gpt-4.1', enabled: 1, is_shared: 0, thinking_effort: 'Medium', has_api_key: true, can_edit: true, models: 'gpt-4.1\ngpt-4.1-mini\ngpt-4o' },
    { name: 'provider-2', title: 'Research bench', kind: 'OpenAI', model: 'gpt-4.1', enabled: 1, is_shared: 0, thinking_effort: 'Medium', has_api_key: true, can_edit: true, models: 'gpt-4.1\ngpt-4.1-mini\ngpt-4o\ngpt-4o-mini\no1\no3\no3-mini\no4-mini\ngpt-3.5-turbo' },
    { name: 'provider-3', title: 'Local gateway', kind: 'Custom', model: 'kimi-k3', enabled: 1, is_shared: 0, thinking_effort: 'Auto', has_api_key: true, can_edit: true, models: '' }
  ];
  const conversations = [
    { name: 'chat-1', title: 'Review outstanding sales orders', provider: 'provider-1', modified: timestamp, active_run: (scene === 'approval' || scene === 'bulk') ? 'run-1' : null, archived: 0, owner: 'jamie@example.invalid', shared: 0 },
    { name: 'chat-2', title: 'A clearer month-end checklist', provider: 'provider-1', modified: '2026-09-15 15:12:00', archived: 0, owner: 'jamie@example.invalid', shared: 0 },
    { name: 'chat-3', title: 'Understand our delivery workflow', provider: 'provider-1', modified: '2026-09-14 10:11:00', archived: 0, owner: 'jamie@example.invalid', shared: 0 },
    { name: 'chat-4', title: 'Notes from the supplier review', provider: 'provider-1', modified: '2026-09-12 09:45:00', archived: 0, owner: 'jamie@example.invalid', shared: 0 }
  ];
  const sharedConversations = [
    { name: 'shared-1', title: 'Q3 stock reconciliation notes', provider: 'provider-1', modified: '2026-09-13 12:02:00', archived: 0, owner: 'alex@example.invalid', shared: 1 }
  ];
  const snapshots = {};
  for (const row of conversations.concat(sharedConversations)) snapshots[row.name] = { conversation: row, messages: [], approvals: [], files: [], run: null, can_post: row.owner === 'jamie@example.invalid' && !row.archived };
  snapshots['chat-1'].messages = [
    { name: 'message-1', role: 'user', content: 'Which sales orders are still waiting to be delivered? Help me see what needs attention this week.', status: 'complete', creation: timestamp },
    { name: 'message-2', role: 'assistant', content: 'I can look for open sales orders and compare their delivery dates.\n\nI will start with a **read-only search** for submitted orders that are not fully delivered. I will only see the records your account is allowed to access.\n\nPlease review the request below before I continue.', status: 'complete', creation: timestamp }
  ];
  snapshots['chat-1'].files = [{ name: 'file-1', file_name: 'delivery-schedule-week38.pdf', file_url: '/private/files/delivery-schedule-week38.pdf', is_private: 1, file_size: 48230 }];
  snapshots['shared-1'].messages = [
    { name: 'message-30', role: 'user', content: 'Summarize the stock reconciliation differences for Q3.', status: 'complete', creation: '2026-09-13 11:58:00' },
    { name: 'message-31', role: 'assistant', content: 'Fictional preview summary of the shared reconciliation conversation. Read only for you.', status: 'complete', creation: '2026-09-13 12:02:00' }
  ];
  if (scene === 'approval') {
    snapshots['chat-1'].run = { name: 'run-1', state: 'awaiting_approval', step_count: 1 };
    snapshots['chat-1'].approvals = [{ name: 'approval-1', tool_name: 'create_record', status: 'pending', expires_at: '2026-09-17 10:24:00', creation: timestamp, preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create the fictional supplier record Acme Corp with default payment terms.', doctype: 'Supplier', name: 'Acme Corp', fields: { supplier_name: 'Acme Corp', supplier_group: 'Commercial' }, changes: [{ field: 'supplier_name', label: 'Supplier name', before: '-', after: 'Acme Corp' }], details: { fields: ['supplier_name', 'supplier_group'], limit: 1 } } }];
  }
  if (scene === 'bulk') {
    const t = (minute) => '2026-09-16 10:' + String(minute).padStart(2, '0') + ':00';
    snapshots['chat-1'].run = { name: 'run-1', state: 'awaiting_approval', step_count: 3 };
    snapshots['chat-1'].approvals = [
      { name: 'approval-b1', tool_name: 'create_record', status: 'pending', expires_at: '2026-09-17 10:24:00', creation: t(25), preview: { action: "Create Supplier 'Acme Corp'", summary: 'Create the fictional supplier record Acme Corp.', doctype: 'Supplier', name: 'Acme Corp', fields: { supplier_name: 'Acme Corp', supplier_group: 'Commercial' }, changes: [{ field: 'supplier_name', label: 'Supplier name', before: '-', after: 'Acme Corp' }], details: { fields: ['supplier_name', 'supplier_group'] } } },
      { name: 'approval-b2', tool_name: 'update_record', status: 'pending', expires_at: '2026-09-17 10:24:00', creation: t(26), preview: { action: "Update Sales Order 'SO-DEMO-1042'", summary: 'Update the fictional sales order delivery note.', doctype: 'Sales Order', name: 'SO-DEMO-1042', fields: { delivery_date: '2026-09-25' }, changes: [{ field: 'delivery_date', label: 'Delivery date', before: '2026-09-18', after: '2026-09-25' }], details: { fields: ['delivery_date'] } } },
      { name: 'approval-b3', tool_name: 'delete_record', status: 'pending', expires_at: '2026-09-17 10:24:00', creation: t(27), preview: { action: "Delete ToDo 'TODO-DEMO-9'", summary: 'Delete the fictional follow-up ToDo.', doctype: 'ToDo', name: 'TODO-DEMO-9', operation: 'delete', details: {} } }
    ];
  }
  if (scene === 'auto') {
    const t = (minute) => '2026-09-16 10:' + String(minute).padStart(2, '0') + ':00';
    snapshots['chat-1'].run = { name: 'run-1', state: 'completed', step_count: 2 };
    snapshots['chat-1'].approvals = [
      { name: 'approval-a1', tool_name: 'read_record', status: 'succeeded', decided_by: '', source: 'policy:Read auto-approve', creation: t(25), preview: { summary: "Read Supplier 'Acme Corp'.", operation: 'read', target: { doctype: 'Supplier', name: 'Acme Corp' }, details: { fields: ['name', 'supplier_group'] } } },
      { name: 'approval-a2', tool_name: 'search_records', status: 'succeeded', decided_by: 'jamie@example.invalid', creation: t(26), preview: { summary: 'Search permitted Item records.', operation: 'search', target: { doctype: 'Item' }, details: { limit: 5 } } }
    ];
    snapshots['chat-1'].messages.push({ name: 'message-40', role: 'assistant', content: 'The policy auto-approved the read; the search had an existing manual approval. All figures are mock preview data.', status: 'complete', creation: t(27) });
  }
  const memories = [{ name: 'memory-1', scope: 'personal', content: 'Use a Monday-to-Sunday week when reviewing delivery schedules.' }];
  const skillsData = {
    tools: [
      { name: 'search_records', description: 'Find records you can access.', mutates: false, external: false, version: '1', enabled: 1 },
      { name: 'create_todo', description: 'Create a private ToDo for yourself.', mutates: true, external: false, version: '2', enabled: 1 }
    ],
    scopes: { read: ['Customer', 'ToDo'], write: ['ToDo'] },
    never_allow: ['User', 'DocType'],
    learned_skills: [
      { name: 'skill-month-end-close', title: 'Month-end close helper', description: 'Guides the assistant through the fictional month-end checklist.', instructions: 'Summarize open ToDos before listing overdue invoices.', origin: 'Seeded', enabled: 1, shared: 1, version: 3, can_edit: 1, scope_read: 'ToDo\nSales Invoice', scope_write: 'ToDo' },
      { name: 'skill-supplier-follow-up', title: 'Supplier follow-up drafts', description: 'Drafts follow-up notes for late suppliers. Nothing is sent.', instructions: 'Draft a short note. Never send anything.', origin: 'Learned', enabled: 0, shared: 0, version: 1, can_edit: 1, scope_read: 'Supplier', scope_write: '' }
    ]
  };
  const settings = {
    enabled: 1, approval_mode: 'Approve Writes Only', max_steps: 12, max_tokens: 64000, max_run_seconds: 600,
    approval_expiry_minutes: 1440, max_upload_mb: 10, max_file_chars: 120000, daily_run_limit: 40,
    allowed_read_doctypes: 'Customer\nToDo', allowed_write_doctypes: 'ToDo', allowed_reports: '',
    enabled_tools: 'search_records\ncreate_todo', allowed_custom_hosts: ''
  };
  if (scene === 'tools' || scene === 'busy') {
    const t = (minute) => '2026-09-16 10:' + String(minute).padStart(2, '0') + ':00';
    snapshots['chat-1'].approvals = [
      { name: 'approval-t1', tool_name: 'search_records', status: 'succeeded', creation: t(25), preview: { summary: 'Search permitted Supplier records.', operation: 'search', target: { doctype: 'Supplier' }, details: { fields: ['name', 'supplier_name'], filters: { supplier_name: ['like', '%Acme%'] }, limit: 5 } } },
      { name: 'approval-t2', tool_name: 'search_records', status: 'succeeded', creation: t(26), preview: { summary: 'Search permitted Item records.', operation: 'search', target: { doctype: 'Item' }, details: { fields: ['name', 'item_name'], filters: { item_name: ['like', '%valve%'] }, limit: 5 } } },
      { name: 'approval-t3', tool_name: 'search_records', status: 'succeeded', creation: t(27), preview: { summary: 'Search permitted Purchase Invoice records.', operation: 'search', target: { doctype: 'Purchase Invoice' }, details: { fields: ['name', 'supplier', 'grand_total'], filters: { supplier: 'Acme Corp' }, limit: 5 } } },
      { name: 'approval-t4', tool_name: 'read_record', status: 'succeeded', creation: t(28), preview: { summary: "Read Supplier 'Acme Corp'.", operation: 'read', target: { doctype: 'Supplier', name: 'Acme Corp' }, details: { fields: ['name', 'supplier_group', 'payment_terms'] } } },
      { name: 'approval-t5', tool_name: 'read_attachment', status: 'succeeded', creation: t(29), preview: { summary: "Read this conversation's private attachment.", operation: 'read_attachment', target: { doctype: 'File', name: 'file-9d580' }, details: { file_name: 'invoice-acme.pdf', file_size: 48230 } } }
    ];
    snapshots['chat-1'].messages.push(
      { name: 'message-3', role: 'assistant', content: 'I found the fictional supplier **Acme Corp**, checked matching items and purchase invoices, and read the attached invoice. Here is what needs attention:\n\n| Invoice | Date | Amount |\n| --- | --- | --- |\n| PI-DEMO-031 | 02 Sep | 1,240.00 |\n| PI-DEMO-044 | 09 Sep | 860.50 |\n\nAll figures are mock preview data.', status: 'complete', creation: t(30) }
    );
    for (let index = 0; index < 8; index++) {
      snapshots['chat-1'].messages.push(
        { name: 'message-f' + index + 'u', role: 'user', content: 'Follow-up question ' + (index + 1) + ': break the fictional numbers down by week so the thread stays long enough to scroll.', status: 'complete', creation: t(31 + index * 2) },
        { name: 'message-f' + index + 'a', role: 'assistant', content: 'Fictional preview answer ' + (index + 1) + '. The figures below exist only to fill the thread so scrolling can be exercised.\n\n| Week | Fictional total |\n| --- | --- |\n| W38 | 402.10 |\n| W39 | 512.75 |', status: 'complete', creation: t(32 + index * 2) }
      );
    }
  }
  if (scene === 'busy') {
    for (let index = 5; index <= 40; index++) {
      const conversation = { name: 'chat-' + index, title: 'Archive review ' + index, provider: 'provider-1', modified: '2026-09-1' + (index % 10) + ' 08:00:00', archived: 0, owner: 'jamie@example.invalid', shared: 0 };
      conversations.push(conversation);
      snapshots[conversation.name] = { conversation, messages: [], approvals: [], files: [], run: null, can_post: true };
    }
  }
  const handlers = {};
  let sequence = 10, route = ['intelligence'];
  const preview = window.preview = { scene, calls: [], offline: false, providers, conversations, sharedConversations, snapshots, memories, emit: (event) => (handlers.intelligence_update || []).forEach((callback) => callback(event)) };
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
      case 'bootstrap': return { enabled: true, user: 'jamie@example.invalid', user_name: 'Jamie Davis', is_manager: true, providers: providers.filter((row) => row.enabled), managed_providers: providers, capabilities: { attachments: true, memory: true, shared_memory: true, provider_management: true, streaming: false }, defaults: { max_upload_mb: 10, approval_expiry_minutes: 1440, approval_mode: 'Approve Every Step' } };
      case 'list_conversations': {
        if (Number(args.shared || 0)) return sharedConversations;
        return conversations.filter((row) => Number(row.archived || 0) === Number(args.archived || 0) && row.title.toLowerCase().includes((args.search || '').toLowerCase()));
      }
      case 'get_conversation': if (!snapshot) throw { userMessage: 'Conversation not found.' }; return snapshot;
      case 'create_conversation': {
        const conversation = { name: 'chat-' + (++sequence), title: 'New conversation', provider: args.provider, modified: timestamp, archived: 0, owner: 'jamie@example.invalid', shared: 0 };
        conversations.unshift(conversation); snapshots[conversation.name] = { conversation, messages: [], approvals: [], files: [], run: null, can_post: true }; return conversation;
      }
      case 'send_message': {
        if (snapshot.run && ['running', 'queued', 'awaiting_approval'].includes(snapshot.run.state)) throw { userMessage: 'This conversation already has an active run.' };
        if (!snapshot.messages.length) snapshot.conversation.title = args.content.slice(0, 80);
        snapshot.messages.push({ name: 'message-' + (++sequence), role: 'user', content: args.content, status: 'complete', creation: timestamp });
        snapshot.run = { name: 'run-' + (++sequence), state: 'running', step_count: 1 }; snapshot.conversation.active_run = snapshot.run.name;
        setTimeout(() => {
          if (snapshot.run.state !== 'running') return;
          snapshot.run.state = 'awaiting_approval';
          snapshot.messages.push({ name: 'message-' + (++sequence), role: 'assistant', content: '**Mock preview response.** I can help by reading the relevant records. Review this example request before continuing; no actual records will be accessed in this preview.', status: 'complete', creation: timestamp });
          snapshot.approvals.push({ name: 'approval-' + (++sequence), tool_name: 'search_records', status: 'pending', creation: timestamp, preview: { action: "Search Customer records", summary: 'Example: read a small set of permitted customer records.', doctype: 'Customer', details: { fields: ['name', 'customer_name'], limit: 5 } } }); changed(snapshot);
        }, 900); return snapshot.run;
      }
      case 'approve': {
        const match = Object.values(snapshots).find((row) => row.approvals.some((approval) => approval.name === args.approval));
        const approval = match.approvals.find((row) => row.name === args.approval); approval.status = args.decision === 'deny' ? 'denied' : 'approved'; match.run.state = 'running'; changed(match);
        setTimeout(() => {
          if (args.decision !== 'deny') approval.status = 'succeeded';
          finish(match, 'completed', args.decision !== 'deny' ? '### Review complete\n\nThis is **fictional preview data**, not a live report. Your approved request completed in the mock host.\n\n| Order | Customer | Delivery |\n| --- | --- | --- |\n| SO-DEMO-1042 | Northstar Components | 18 Sep |\n| SO-DEMO-1048 | Fieldwork Supply | 21 Sep |\n\nNo records were changed. You can ask a follow-up question or leave this conversation and return later.' : 'The request was denied. No records were read or changed.');
        }, 750); return match.run;
      }
      case 'decide_approvals': {
        const names = JSON.parse(args.names || '[]');
        const match = Object.values(snapshots).find((row) => row.approvals.some((approval) => names.includes(approval.name)));
        if (!match) throw { userMessage: 'Approvals not found.' };
        for (const approval of match.approvals) if (names.includes(approval.name) && approval.status === 'pending') approval.status = args.decision === 'deny' ? 'denied' : 'approved';
        match.run.state = 'running'; changed(match);
        setTimeout(() => {
          for (const approval of match.approvals) if (approval.status === 'approved') approval.status = 'succeeded';
          finish(match, 'completed', args.decision === 'deny' ? 'The requests were denied. No records were changed.' : '### Review complete\n\nEvery approved request completed in the mock host. This is **fictional preview data**, not a live report.');
        }, 750); return match.run;
      }
      case 'cancel': {
        const match = Object.values(snapshots).find((row) => row.run && row.run.name === args.run); match.run.state = 'cancelled'; match.conversation.active_run = null; changed(match); return match.run;
      }
      case 'rename_conversation': snapshot.conversation.title = args.title; return snapshot.conversation;
      case 'archive_conversation': snapshot.conversation.archived = args.archived; snapshot.can_post = !args.archived; return snapshot.conversation;
      case 'share_conversation': snapshot.conversation.shared = args.shared; return snapshot.conversation;
      case 'fetch_provider_models': return { models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'] };
      case 'skills': return skillsData;
      case 'get_settings': return settings;
      case 'save_settings': Object.assign(settings, args); return settings;
      case 'frappe.client.get': return settings;
      case 'frappe.client.set_value': {
        if (args.doctype === 'Intelligence Skill') {
          const skill = skillsData.learned_skills.find((row) => row.name === args.name);
          if (!skill) throw { userMessage: 'Skill not found.' };
          Object.assign(skill, args.fieldname || {}); return skill;
        }
        Object.assign(settings, args.fieldname || {}); return settings;
      }
      case 'provider_details': return providers.find((row) => row.name === args.name);
      case 'save_provider': {
        let provider = providers.find((row) => row.name === args.name); if (!provider) { provider = { name: 'provider-' + (++sequence) }; providers.push(provider); }
        Object.assign(provider, { title: args.title, kind: args.kind, model: args.model, base_url: args.base_url, enabled: args.enabled, is_shared: args.is_shared, thinking_effort: args.thinking_effort || 'Auto', models: args.models || '', has_api_key: true, can_edit: true }); return provider;
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
    show_alert: (opts) => { preview.lastAlert = opts && opts.message || String(opts); },
    ui: { make_app_page: ({ parent }) => ({ main: [parent] }), freeze: () => { preview.frozen = true; }, unfreeze: () => { preview.frozen = false; } },
    call: ({ method, args, callback, error }) => api(method.replace('frappe_intelligence.api.', ''), args || {}).then((data) => { callback({ message: clone(data) }); }).catch((failure) => { error(failure); })
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (url, options) => {
    if (String(url).endsWith('frappe_intelligence.api.upload_attachment')) {
      preview.calls.push({ method: 'upload_attachment', args: { conversation: options.body.get('conversation') } });
      const file = options.body.get('file'); const attachment = { name: 'file-' + (++sequence), file_name: file.name, file_url: '/private/files/' + encodeURIComponent(file.name), is_private: 1, file_size: file.size };
      snapshots[options.body.get('conversation')].files.push(attachment);
      return new Response(JSON.stringify({ message: attachment }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
})();
