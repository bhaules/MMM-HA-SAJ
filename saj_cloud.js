/* SAJ eSolar / Elekeeper cloud client (only what MMM-HA-SAJ needs: today's totals).
 *
 * Ported from MMM-SAJ's node_helper. Used for the daily comparison only:
 * live values come from Home Assistant.
 */
const https = require("https");
const crypto = require("crypto");

// Public constants of the Elekeeper web app (not user secrets).
const QUERY_SIGN_KEY = "ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe";
const PASSWORD_ENCRYPTION_KEY = "ec1840a7c53cf0709eb784be480379b6";

const HOSTS = {
	eu: "eop.saj-electric.com",
	in: "iop.saj-electric.com",
	cn: "op.saj-electric.cn"
};

class SajCloud {
	constructor ({ region = "eu", username, password }) {
		this.host = HOSTS[region] || HOSTS.eu;
		this.username = username;
		this.password = password;
		this.token = null;
		this.tokenExpiresAt = 0;
		this.plantUid = null;
		this.deviceSn = null;
	}

	headers (token) {
		const origin = `https://${this.host}`;
		const h = {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			Accept: "application/json, text/plain, */*",
			"Accept-Language": "en",
			Origin: origin,
			Referer: `${origin}/`,
			"Content-Language": "zh_CN",
			lang: "en",
			"X-App-Project-Name": "elekeeper",
			"X-Client-Code": "organization",
			"X-Client-Date": new Date().toISOString().split("T")[0],
			"X-Lang": "en",
			"X-Timestamp": String(Date.now()),
			"X-Theme-Color": "light",
			"X-Trace-Id": crypto.randomBytes(8).toString("hex")
		};
		if (token) h.Authorization = token;
		return h;
	}

	request (options, body) {
		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let data = "";
				res.on("data", (c) => { data += c; });
				res.on("end", () => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						return reject(new Error(`SAJ HTTP ${res.statusCode}`));
					}
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(new Error(`SAJ bad JSON: ${e.message}`));
					}
				});
			});
			req.on("error", reject);
			req.setTimeout(30000, () => req.destroy(new Error("SAJ request timeout")));
			if (body) req.write(body);
			req.end();
		});
	}

	postV2 (path, payload, token) {
		const body = JSON.stringify({
			appProjectName: "elekeeper",
			clientDate: new Date().toISOString().split("T")[0],
			lang: "en",
			timeStamp: Date.now(),
			clientId: "esolar-monitor-admin",
			clientCode: "organization",
			themeColor: "light",
			...payload
		});
		return this.request({
			hostname: this.host,
			path: `/dev-api/api/v2${path}`,
			method: "POST",
			headers: {
				...this.headers(token),
				"Content-Type": "application/json;charset=utf-8",
				"Content-Length": Buffer.byteLength(body)
			}
		}, body);
	}

	getV1 (path, params, token) {
		const signed = signParams({
			...params,
			appProjectName: "elekeeper",
			clientDate: new Date().toISOString().split("T")[0],
			lang: "en",
			timeStamp: Date.now(),
			random: randomKey(32),
			clientId: "esolar-monitor-admin"
		});
		return this.request({
			hostname: this.host,
			path: `/dev-api/api/v1${path}?${new URLSearchParams(signed).toString()}`,
			method: "GET",
			headers: this.headers(token)
		});
	}

	async login () {
		const r = await this.postV2("/sys/user/login", {
			username: this.username,
			password: encryptPassword(this.password),
			rememberMe: false,
			loginType: 1
		});
		if (r.errCode !== 0 || !r.data || !r.data.token) {
			throw new Error(`SAJ login failed: ${r.errMsg || r.errCode}`);
		}
		this.token = r.data.tokenHead + r.data.token;
		this.tokenExpiresAt = Date.now() + (r.data.expiresIn || 1296000) * 1000;
		return this.token;
	}

	async validToken () {
		if (this.token && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) return this.token;
		return this.login();
	}

	async ensurePlant (token) {
		if (this.plantUid) return;
		const plants = await this.getV1("/monitor/plant/getEndUserPlantList", { pageNo: 1, pageSize: 10 }, token);
		if (plants.errCode && plants.errCode !== 0) throw new SajAuthError(plants);
		const list = plants.data && plants.data.list;
		if (!list || !list.length) throw new Error("SAJ: no plants found");
		this.plantUid = list[0].plantUid;
		const devices = await this.getV1("/monitor/device/getDeviceList", { plantUid: this.plantUid, pageSize: 10, pageNo: 1 }, token);
		const dl = devices.data && devices.data.list;
		if (dl && dl.length) this.deviceSn = dl[0].deviceSn;
	}

	/* Returns today's totals in kWh as the SAJ cloud reports them. */
	async todayTotals () {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const token = await this.validToken();
				await this.ensurePlant(token);
				const r = await this.postV2("/monitor/plantHome/getPlantEnergyStatistics", {
					plantUid: this.plantUid,
					sn: this.deviceSn,
					snType: 1
				}, token);
				if (r.errCode && r.errCode !== 0) throw new SajAuthError(r);
				return parseStats(r.data);
			} catch (e) {
				if (attempt === 0 && e instanceof SajAuthError) {
					this.token = null;
					continue;
				}
				throw e;
			}
		}
		throw new Error("SAJ: unreachable");
	}
}

class SajAuthError extends Error {
	constructor (resp) {
		super(`SAJ API error ${resp.errCode}: ${resp.errMsg || ""}`);
	}
}

function parseStats (data) {
	const out = { pv: null, load: null, import: null, export: null, batCharge: null, batDischarge: null };
	for (const item of (data && data.energyDataList) || []) {
		if (item.dataType === "PV_ENERGY") out.pv = item.energy1Today;
		else if (item.dataType === "LOAD_ENERGY") out.load = item.energy1Today;
		else if (item.dataType === "BUY_AND_SELL") {
			out.import = item.energy1Today;
			out.export = item.energy2Today;
		} else if (item.dataType === "CHARGE_AND_DISCHARGE") {
			out.batCharge = item.energy1Today;
			out.batDischarge = item.energy2Today;
		}
	}
	return out;
}

function signParams (data) {
	const keys = Object.keys(data).sort();
	const str = `${keys.map((k) => `${k}=${data[k]}`).join("&")}&key=${QUERY_SIGN_KEY}`;
	const md5 = crypto.createHash("md5").update(str, "latin1").digest("hex");
	const sha1 = crypto.createHash("sha1").update(md5).digest("hex");
	return { ...data, signature: sha1.toUpperCase(), signParams: keys.join(",") };
}

function encryptPassword (password) {
	const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(PASSWORD_ENCRYPTION_KEY, "hex"), null);
	return cipher.update(password, "utf8", "hex") + cipher.final("hex");
}

function randomKey (n) {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
	return s;
}

module.exports = SajCloud;
