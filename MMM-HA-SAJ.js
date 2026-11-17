/* MMM-HA-SAJ: SAJ solar/battery panel fed by Home Assistant, with the Solcast forecast. */
Module.register("MMM-HA-SAJ", {
	defaults: {
		haUrl: "http://homeassistant.local:8123",
		haToken: "",
		entities: {
			pvPower: "sensor.saj_pv_power",
			loadPower: "sensor.saj_total_load_power",
			batteryPower: "sensor.saj_battery_power", // + = discharging, - = charging
			batterySoc: "sensor.saj_battery_energy_percent",
			gridPower: "sensor.saj_ct_grid_power_total", // + = import, - = export
			pvToday: "sensor.saj_power_current_day",
			loadToday: "sensor.saj_total_today_load",
			importToday: "sensor.saj_feed_in_today_energy", // SAJ "feed-in" = bought from the grid
			exportToday: "sensor.saj_sell_today_energy", // SAJ "sell" = sent to the grid
			batChargeToday: "sensor.saj_battery_today_charge",
			batDischargeToday: "sensor.saj_battery_today_discharge",
			forecastToday: "sensor.solcast_pv_forecast_forecast_today",
			forecastTomorrow: "sensor.solcast_pv_forecast_forecast_tomorrow"
		},
		invertBatteryPower: false,
		invertGridPower: false,
		idleThreshold: 50, // W; below this a flow counts as idle (CT noise)
		batteryCapacity: 20, // kWh, 0 to hide
		updateInterval: 30 * 1000,
		forecastInterval: 5 * 60 * 1000,
		forecastMorningHour: 7, // yesterday's "forecast" = Solcast's figure at this hour
		showChart: true,
		showComparison: true,
		decimalSeparator: ".",
		sajCloud: null, // { region, username, password, interval, activeHoursStart, activeHoursEnd }
		sajFinalHour: 20 // SAJ cloud figure counts as the day's total if fetched at/after this hour
	},

	configDeepMerge: true,

	getStyles () {
		return ["MMM-HA-SAJ.css"];
	},

	start () {
		this.payload = null;
		this.sendSocketNotification("HA_SAJ_CONFIG", this.config);
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "HA_SAJ_DATA") return;
		this.payload = payload;
		this.updateDom(0);
	},

	/* ---------- formatting ---------- */

	fmt (n, d) {
		if (n === null || n === undefined || Number.isNaN(n)) return "–";
		return n.toFixed(d).replace(".", this.config.decimalSeparator);
	},
	kW (w) {
		return w === null ? "–" : `${this.fmt(Math.abs(w) / 1000, 2)} kW`;
	},
	kWh (v, d = 2) {
		return `${this.fmt(v, d)} kWh`;
	},

	el (tag, cls, html) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html !== undefined) e.innerHTML = html;
		return e;
	},

	img (name) {
		return `<img src="${this.file(`images/${name}.svg`)}">`;
	},

	batteryIcon (soc) {
		const fill = Math.max(0, Math.min(100, soc || 0)) / 100 * 48;
		const color = soc > 20 ? "#339933" : "#FF3333";
		return `<svg width="60" height="34" viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg">
			<rect stroke="#888" stroke-width="2" fill="none" x="1" y="5" width="52" height="30" rx="3"/>
			<path d="M54,12 L54,28 L57,28 L57,12 Z" fill="#888"/>
			<rect fill="${color}" x="3" y="7" width="${fill}" height="26" rx="1"/></svg>`;
	},

	/* ---------- DOM ---------- */

	getDom () {
		const w = this.el("div", "hasaj");
		const p = this.payload;
		if (!p || !p.live) {
			w.className = "hasaj dimmed light small";
			const err = p && Object.values(p.errors || {})[0];
			w.innerHTML = err ? `Solar: ${err}` : "Loading solar data…";
			return w;
		}
		w.appendChild(this.flowDom(p.live));
		if (this.config.showChart && p.forecast) {
			w.appendChild(this.solarHeadDom(p.live, p.forecast));
			w.appendChild(this.el("div", "hasaj-chart", this.chartSvg(p.forecast)));
		}
		w.appendChild(this.tableDom(p.live));
		const foot = this.footerDom(p);
		if (foot) w.appendChild(foot);
		return w;
	},

	flowDom (v) {
		const idle = this.config.idleThreshold;
		const g = this.el("div", "hasaj-flow");

		g.appendChild(this.el("div", "hasaj-pv",
			`<div class="hasaj-val">${this.kW(v.pvPower)}</div><div class="hasaj-icon">${this.img("pv")}</div>`));
		g.appendChild(this.el("div", "hasaj-arrow-pv",
			`<div class="hasaj-icon">${this.img(v.pvPower > idle ? "arrow_right_green" : "arrow_none")}</div>`));

		let socLine = `${this.fmt(v.batterySoc, 0)} %`;
		const cap = parseFloat(this.config.batteryCapacity);
		if (cap > 0 && v.batterySoc !== null) socLine += ` <span class="hasaj-dim">${this.fmt(v.batterySoc / 100 * cap, 1)} kWh</span>`;
		g.appendChild(this.el("div", "hasaj-battery",
			`<div class="hasaj-val">${this.kW(v.batteryPower)}</div><div class="hasaj-icon">${this.batteryIcon(v.batterySoc)}</div>`
			+ `<div class="hasaj-val">${socLine}</div>`));

		let batArrow = "arrow_none";
		if (v.batteryPower > idle) batArrow = "arrow_right_red"; // discharging: battery -> home
		else if (v.batteryPower < -idle) batArrow = "arrow_left_green"; // charging: home -> battery
		g.appendChild(this.el("div", "hasaj-arrow-bat", `<div class="hasaj-icon">${this.img(batArrow)}</div>`));

		g.appendChild(this.el("div", "hasaj-home",
			`<div class="hasaj-icon">${this.img("home")}</div><div class="hasaj-val">${this.kW(v.loadPower)}</div>`));

		let gridArrow = "arrow_none";
		if (v.gridPower > idle) gridArrow = "arrow_left_red"; // importing
		else if (v.gridPower < -idle) gridArrow = "arrow_right_green"; // exporting
		g.appendChild(this.el("div", "hasaj-arrow-grid", `<div class="hasaj-icon">${this.img(gridArrow)}</div>`));

		const gridW = v.gridPower !== null && Math.abs(v.gridPower) <= idle ? 0 : v.gridPower;
		g.appendChild(this.el("div", "hasaj-grid",
			`<div class="hasaj-icon">${this.img("grid")}</div><div class="hasaj-val">${this.kW(gridW)}</div>`));
		return g;
	},

	solarHeadDom (v, f) {
		return this.el("div", "hasaj-head",
			`<span>Solar today <b>${this.kWh(v.pvToday)}</b>`
			+ `<span class="hasaj-dim"> / ${this.fmt(f.today, 1)} forecast</span></span>`
			+ `<span>Tomorrow <b>${this.kWh(f.tomorrow, 1)}</b></span>`);
	},

	tableDom (v) {
		const t = this.el("table", "hasaj-table");
		const cell = (l, val) => `<td class="hasaj-l">${l}</td><td class="hasaj-r">${val}</td>`;
		let self = null;
		if (v.loadToday > 0 && v.importToday !== null) self = Math.max(0, Math.min(100, (1 - v.importToday / v.loadToday) * 100));
		t.appendChild(this.el("tr", "", cell("Used", this.kWh(v.loadToday)) + cell("Export", this.kWh(v.exportToday))
			+ cell("Import", this.kWh(v.importToday))));
		t.appendChild(this.el("tr", "", cell("Batt in", this.kWh(v.batChargeToday)) + cell("Batt out", this.kWh(v.batDischargeToday))
			+ cell("Self-powered", self === null ? "–" : `${this.fmt(self, 0)} %`)));
		return t;
	},

	footerDom (p) {
		const parts = [];
		const y = p.yesterday;
		if (this.config.showComparison && y && y.actual !== null) {
			let s = `Yesterday <b>${this.kWh(y.actual, 1)}</b>`;
			if (y.forecast) {
				const diff = Math.round((y.actual / y.forecast - 1) * 100);
				s += ` · forecast ${this.fmt(y.forecast, 1)} (${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${Math.abs(diff)} %)`;
			}
			if (y.saj !== null && y.saj !== undefined) s += ` · SAJ app ${this.fmt(y.saj, 1)}`;
			parts.push(s);
		}
		const errs = Object.entries(p.errors || {});
		if (errs.length) parts.push(`<span class="hasaj-err">⚠ ${errs.map(([k, m]) => `${k}: ${m}`).join("; ")}</span>`);
		if (!parts.length) return null;
		return this.el("div", "hasaj-foot", parts.join("<br>"));
	},

	/* Today's forecast curve (Solcast, with 10–90 % band) and the actual PV so far. */
	chartSvg (f) {
		const W = 560, H = 80, top = 4, bottom = 17, left = 4, right = 4;
		const per = f.periods || [];
		const HALF = 15 * 60 * 1000;
		const sunny = per.filter((p) => p.p90 > 0.01 || p.est > 0.01);
		let t0, t1;
		if (sunny.length) {
			t0 = sunny[0].t - 2 * HALF;
			t1 = sunny[sunny.length - 1].t + 4 * HALF;
		} else {
			const d = new Date(f.now);
			t0 = d.setHours(5, 0, 0, 0);
			t1 = d.setHours(20, 0, 0, 0);
		}
		const act = (f.actual || []).filter((a) => a.kw !== null && a.t + 2 * HALF > t0 && a.t < t1);
		let ymax = Math.max(0.5, ...per.map((p) => Math.max(p.p90 || 0, p.est || 0)), ...act.map((a) => a.kw));
		ymax = Math.ceil(ymax * 1.05 * 2) / 2;
		const x = (t) => left + (Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0) * (W - left - right);
		const y = (kw) => top + (1 - kw / ymax) * (H - top - bottom);
		const pts = (arr) => arr.map(([t, k]) => `${x(t).toFixed(1)},${y(k).toFixed(1)}`).join(" ");

		const inRange = per.filter((p) => p.t + 2 * HALF >= t0 && p.t <= t1);
		let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`;

		// hour grid + labels
		const d = new Date(t0);
		d.setMinutes(0, 0, 0);
		for (let t = d.getTime(); t <= t1; t += 3600 * 1000) {
			const h = new Date(t).getHours();
			if (t < t0 || h % 3) continue;
			svg += `<line x1="${x(t)}" y1="${top}" x2="${x(t)}" y2="${H - bottom}" class="hasaj-gridline"/>`;
			svg += `<text x="${x(t)}" y="${H - 3}" class="hasaj-axis" text-anchor="middle">${h}:00</text>`;
		}
		svg += `<line x1="${left}" y1="${y(0)}" x2="${W - right}" y2="${y(0)}" class="hasaj-baseline"/>`;
		svg += `<text x="${left + 2}" y="${top + 10}" class="hasaj-axis">${this.fmt(ymax, 1)} kW</text>`;

		if (inRange.length) {
			const mid = inRange.map((p) => p.t + HALF);
			const band = inRange.map((p, i) => [mid[i], p.p90 || 0]).concat(inRange.map((p, i) => [mid[i], p.p10 || 0]).reverse());
			svg += `<polygon points="${pts(band)}" class="hasaj-band"/>`;
		}
		if (act.length) {
			const line = act.map((a) => [a.partial ? Math.min(a.t + HALF, f.now) : a.t + HALF, a.kw]);
			const area = [[line[0][0], 0], ...line, [line[line.length - 1][0], 0]];
			svg += `<polygon points="${pts(area)}" class="hasaj-actual-area"/>`;
			svg += `<polyline points="${pts(line)}" class="hasaj-actual"/>`;
		}
		if (inRange.length) {
			svg += `<polyline points="${pts(inRange.map((p) => [p.t + HALF, p.est || 0]))}" class="hasaj-forecast"/>`;
		}
		if (f.now > t0 && f.now < t1) {
			svg += `<line x1="${x(f.now)}" y1="${top}" x2="${x(f.now)}" y2="${H - bottom}" class="hasaj-now"/>`;
		}
		return `${svg}</svg>`;
	}
});
