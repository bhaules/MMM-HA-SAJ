/* MMM-HA-SAJ node helper
 *
 * - Live power + today's counters: Home Assistant REST API (local, every updateInterval).
 * - Solar forecast: Solcast entities in Home Assistant (curve for today, total for tomorrow).
 * - Actual PV curve for today: Home Assistant history of the PV power sensor.
 * - Daily comparison: yesterday's actual vs the morning forecast, and (optional) vs the SAJ cloud.
 */
const NodeHelper = require("node_helper");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const SajCloud = require("./saj_cloud");

const CACHE_FILE = path.join(__dirname, ".saj-cloud-cache.json");
const BUCKET_MS = 30 * 60 * 1000; // same as Solcast's detailedForecast periods

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.started = false;
		this.state = { live: null, forecast: null, yesterday: null, sajToday: null, errors: {} };
		this.yesterdayKey = null;
		this.saj = null;
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "HA_SAJ_CONFIG") return;
		// Each browser (re)load sends the config again: only start the timers once.
		if (this.started) {
			this.push();
			return;
		}
		this.started = true;
		this.config = payload;
		if (payload.sajCloud && payload.sajCloud.username) {
			this.saj = new SajCloud(payload.sajCloud);
		}
		this.loop("live", () => this.updateLive(), payload.updateInterval);
		this.loop("forecast", () => this.updateForecast(), payload.forecastInterval);
		if (this.saj) this.loop("saj", () => this.updateSaj(), payload.sajCloud.interval || 60 * 60 * 1000);
	},

	loop (name, fn, interval) {
		const run = async () => {
			try {
				await fn();
				delete this.state.errors[name];
			} catch (e) {
				console.error(`[MMM-HA-SAJ] ${name}: ${e.message}`);
				this.state.errors[name] = e.message;
			}
			this.push();
		};
		run();
		setInterval(run, interval);
	},

	push () {
		this.sendSocketNotification("HA_SAJ_DATA", this.state);
	},

	/* ---------- Home Assistant ---------- */

	haGet (apiPath) {
		const url = new URL(this.config.haUrl.replace(/\/$/, "") + apiPath);
		const lib = url.protocol === "https:" ? https : http;
		return new Promise((resolve, reject) => {
			const req = lib.get(url, { headers: { Authorization: `Bearer ${this.config.haToken}` } }, (res) => {
				let data = "";
				res.on("data", (c) => { data += c; });
				res.on("end", () => {
					if (res.statusCode !== 200) return reject(new Error(`HA HTTP ${res.statusCode} for ${url.pathname}`));
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(new Error(`HA bad JSON: ${e.message}`));
					}
				});
			});
			req.on("error", reject);
			req.setTimeout(20000, () => req.destroy(new Error("HA request timeout")));
		});
	},

	async haStates (ids) {
		const out = {};
		await Promise.all(ids.filter(Boolean).map(async (id) => {
			out[id] = await this.haGet(`/api/states/${id}`);
		}));
		return out;
	},

	/* History of the given entities as {id: [{t, v}]} (v = number or null when unavailable). */
	async haHistory (ids, start, end) {
		const q = `/api/history/period/${start.toISOString()}?filter_entity_id=${ids.join(",")}`
			+ `&end_time=${encodeURIComponent(end.toISOString())}&minimal_response&no_attributes`;
		const series = await this.haGet(q);
		const out = {};
		for (const s of series) {
			if (!s.length) continue;
			out[s[0].entity_id] = s.map((p) => ({ t: Date.parse(p.last_changed), v: num(p.state) }));
		}
		return out;
	},

	async updateLive () {
		const e = this.config.entities;
		const keys = ["pvPower", "loadPower", "batteryPower", "batterySoc", "gridPower",
			"pvToday", "loadToday", "importToday", "exportToday", "batChargeToday", "batDischargeToday"];
		const st = await this.haStates(keys.map((k) => e[k]));
		const v = {};
		for (const k of keys) v[k] = e[k] && st[e[k]] ? num(st[e[k]].state) : null;
		if (this.config.invertBatteryPower && v.batteryPower !== null) v.batteryPower = -v.batteryPower;
		if (this.config.invertGridPower && v.gridPower !== null) v.gridPower = -v.gridPower;
		const pvState = st[e.pvPower];
		v.updated = pvState ? Date.parse(pvState.last_updated) : Date.now();
		this.state.live = v;
	},

	async updateForecast () {
		const e = this.config.entities;
		const now = new Date();
		const midnight = startOfDay(now);
		const st = await this.haStates([e.forecastToday, e.forecastTomorrow]);
		const today = st[e.forecastToday];
		const periods = ((today && today.attributes.detailedForecast) || []).map((p) => ({
			t: Date.parse(p.period_start),
			est: p.pv_estimate,
			p10: p.pv_estimate10,
			p90: p.pv_estimate90
		}));

		const hist = await this.haHistory([e.pvPower], midnight, now);
		const actual = bucketAverage(hist[e.pvPower] || [], midnight.getTime(), now.getTime(), BUCKET_MS)
			.map((b) => ({ t: b.t, kw: b.avg === null ? null : b.avg / 1000, partial: b.partial }));

		this.state.forecast = {
			today: today ? num(today.state) : null,
			tomorrow: st[e.forecastTomorrow] ? num(st[e.forecastTomorrow].state) : null,
			periods,
			actual,
			now: now.getTime()
		};

		const key = dayKey(now);
		if (this.yesterdayKey !== key) {
			await this.updateYesterday(midnight);
			this.yesterdayKey = key;
		}
	},

	async updateYesterday (todayMidnight) {
		const e = this.config.entities;
		const yStart = new Date(todayMidnight);
		yStart.setDate(yStart.getDate() - 1);
		// The daily counter resets just after midnight (00:01 seen), so start a bit later.
		const from = new Date(yStart.getTime() + 10 * 60 * 1000);
		const hist = await this.haHistory([e.pvToday], from, todayMidnight);
		const vals = (hist[e.pvToday] || []).map((p) => p.v).filter((v) => v !== null);
		const actual = vals.length ? Math.max(...vals) : null;

		// "Forecast" = what Solcast said that morning (later in the day it converges to the actual).
		const at = new Date(yStart);
		at.setHours(this.config.forecastMorningHour, 0, 0, 0);
		const fh = await this.haHistory([e.forecastToday], at, new Date(at.getTime() + 1000));
		const fv = (fh[e.forecastToday] || []).map((p) => p.v).filter((v) => v !== null);
		const forecast = fv.length ? fv[0] : null;

		const cache = readCache();
		const sajY = cache[dayKey(yStart)];
		// Only use the SAJ cloud figure if it was fetched after the sun went down.
		const saj = sajY && sajY.hour >= this.config.sajFinalHour ? sajY.pv : null;

		this.state.yesterday = { day: dayKey(yStart), actual, forecast, saj };
	},

	/* ---------- SAJ cloud (daily comparison only) ---------- */

	async updateSaj () {
		const c = this.config.sajCloud;
		const hour = new Date().getHours();
		if (hour < (c.activeHoursStart ?? 6) || hour >= (c.activeHoursEnd ?? 22)) return;
		const t = await this.saj.todayTotals();
		const now = new Date();
		const cache = readCache();
		cache[dayKey(now)] = { ...t, hour, at: now.toISOString() };
		// keep two weeks
		for (const k of Object.keys(cache).sort().slice(0, -14)) delete cache[k];
		writeCache(cache);
		this.state.sajToday = { ...t, at: now.getTime() };
	}
});

/* ---------- helpers ---------- */

function num (s) {
	const n = parseFloat(s);
	return Number.isFinite(n) ? n : null;
}

function startOfDay (d) {
	const m = new Date(d);
	m.setHours(0, 0, 0, 0);
	return m;
}

function dayKey (d) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Time-weighted average of a step series per bucket. Unavailable spans are left out. */
function bucketAverage (points, start, end, size) {
	const buckets = [];
	for (let t = start; t < end; t += size) buckets.push({ t, sum: 0, w: 0, partial: t + size > end });
	const pts = points.filter((p) => !Number.isNaN(p.t)).sort((a, b) => a.t - b.t);
	for (let i = 0; i < pts.length; i++) {
		const v = pts[i].v;
		if (v === null) continue;
		const a = Math.max(pts[i].t, start);
		const b = Math.min(i + 1 < pts.length ? pts[i + 1].t : end, end);
		for (let t = a; t < b;) {
			const idx = Math.floor((t - start) / size);
			const bEnd = Math.min(start + (idx + 1) * size, b);
			buckets[idx].sum += v * (bEnd - t);
			buckets[idx].w += bEnd - t;
			t = bEnd;
		}
	}
	return buckets.map((x) => ({ t: x.t, avg: x.w ? x.sum / x.w : null, partial: x.partial }));
}

function readCache () {
	try {
		return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
	} catch (e) {
		return {};
	}
}

function writeCache (c) {
	try {
		fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1));
	} catch (e) {
		console.error(`[MMM-HA-SAJ] cannot write cache: ${e.message}`);
	}
}

module.exports._test = { bucketAverage, dayKey };
