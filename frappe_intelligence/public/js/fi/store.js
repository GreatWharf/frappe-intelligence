/* Intelligence store: run polling and realtime subscription. */
(function (global, factory) {
	"use strict";
	factory(global);
	if (typeof module === "object" && module.exports) module.exports = global.fi;
})(typeof window !== "undefined" ? window : globalThis, function (global) {
	"use strict";
	const fi = global.fi;
	if (!fi) throw new Error("Intelligence core must load before store");
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
	function subscribeRealtime(handler) {
		// intelligence_run_event (fine-grained lifecycle) arrives before the legacy
		// intelligence_update snapshot at every transition; both carry the
		// conversation name, and polling stays the correctness floor either way.
		if (global.frappe && global.frappe.realtime && global.frappe.realtime.on) {
			global.frappe.realtime.on("intelligence_run_event", handler);
			global.frappe.realtime.on("intelligence_update", handler);
		}
	}
	Object.assign(fi, { Poller, subscribeRealtime });
});
