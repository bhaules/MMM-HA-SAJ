/* Run the node helper once outside MagicMirror and print what the module would get.
 *
 *   node test/test_driver.js /path/to/MagicMirror/config/config.js [--saj]
 *
 * Reads the MMM-HA-SAJ block from config.js (secrets are never printed).
 * --saj also runs one SAJ cloud fetch now (needs sajCloud in the config).
 */
const Module = require("module");
const path = require("path");
const vm = require("vm");
const fs = require("fs");

const sent = [];
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
	if (req === "node_helper") return "node_helper";
	return origResolve.call(this, req, ...rest);
};
require.cache.node_helper = {
	id: "node_helper", filename: "node_helper", loaded: true,
	exports: { create: (o) => ({ ...o, sendSocketNotification: (n, p) => sent.push([n, JSON.parse(JSON.stringify(p))]) }) }
};

// defaults from the front-end file
let defaults;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "MMM-HA-SAJ.js"), "utf8"), {
	Module: { register: (n, d) => { defaults = d.defaults; } }
});

const cfgPath = process.argv[2];
const all = require(path.resolve(cfgPath));
// Without an MMM-HA-SAJ block (first install), use HA_URL / HA_TOKEN from the environment
// and borrow the SAJ login from an old MMM-SAJ block if there is one.
let block = all.modules.find((m) => m.module === "MMM-HA-SAJ");
if (!block) {
	const old = all.modules.find((m) => m.module === "MMM-SAJ");
	block = { config: { haUrl: process.env.HA_URL, haToken: process.env.HA_TOKEN,
		sajCloud: old ? { region: old.config.region, username: old.config.username, password: old.config.password } : null } };
}
if (process.env.HA_TOKEN) block.config.haToken = process.env.HA_TOKEN;
if (process.env.HA_URL) block.config.haUrl = process.env.HA_URL;
const config = { ...defaults, ...block.config, entities: { ...defaults.entities, ...(block.config.entities || {}) } };

const helper = require("../node_helper.js");
helper.start();
helper.config = config;
if (config.sajCloud && config.sajCloud.username) {
	helper.saj = new (require("../saj_cloud"))(config.sajCloud);
}

(async () => {
	const t0 = Date.now();
	await helper.updateLive();
	await helper.updateForecast();
	if (process.argv.includes("--saj") && helper.saj) {
		const c = config.sajCloud;
		config.sajCloud = { ...c, activeHoursStart: 0, activeHoursEnd: 24 };
		await helper.updateSaj();
	}
	const s = helper.state;
	const f = s.forecast;
	console.log("live:", s.live);
	console.log("forecast: today", f.today, "tomorrow", f.tomorrow, "periods", f.periods.length,
		"actual buckets", f.actual.length);
	console.log("actual (kW, 30 min):", f.actual.filter((a) => a.kw).map((a) => `${new Date(a.t).toTimeString().slice(0, 5)}=${a.kw.toFixed(2)}`).join(" "));
	console.log("yesterday:", s.yesterday);
	console.log("sajToday:", s.sajToday);
	console.log("errors:", s.errors, "took", Date.now() - t0, "ms");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
