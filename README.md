# MMM-HA-SAJ

A [MagicMirror²](https://magicmirror.builders/) module for a **SAJ** hybrid inverter (solar + battery) that reads its data from **Home Assistant** instead of the SAJ cloud, and adds the **Solcast** solar forecast.

Successor of MMM-SAJ, which polled the SAJ eSolar/Elekeeper cloud every 5 minutes. The cloud lags behind (its daily totals refresh slowly) and needs your SAJ login on the mirror. Home Assistant already reads the inverter locally over Modbus, so this module:

- shows **live power flow** (solar, battery, home, grid) and battery level from Home Assistant, refreshed every 30 s;
- shows **today's totals**: solar, used, exported, imported, battery in/out, and the share of today's use not bought from the grid ("Self-powered");
- draws **today's solar curve**: actual output (30-minute averages from HA history) against the Solcast forecast and its 10–90 % range, with a "now" line;
- shows **tomorrow's forecast**;
- shows a **daily comparison** for yesterday: actual vs the morning forecast (as a %), and optionally what the SAJ app/cloud reported for the same day.

## Requirements

- Home Assistant with the SAJ inverter integrated (tested with [`saj_h2_modbus`](https://github.com/stanus74/home-assistant-saj-h2-modbus)) and the [Solcast PV Forecast](https://github.com/BJReplay/ha-solcast-solar) integration.
- A Home Assistant long-lived access token (Profile > Security > Long-lived access tokens). A token for its own sake (e.g. named "MagicMirror") can be revoked without affecting anything else.
- MagicMirror² 2.20 or later (uses `configDeepMerge`), Node 18+. No npm dependencies.

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/bhaules/MMM-HA-SAJ.git
```

## Configuration

```javascript
{
	module: "MMM-HA-SAJ",
	position: "top_left",
	config: {
		haUrl: "http://192.168.1.10:8123",
		haToken: "<long-lived access token>",
		batteryCapacity: 20,              // kWh, 0 hides the kWh next to the battery %

		// Optional: compare yesterday with the SAJ cloud (checked once an hour, 06:00-22:00)
		sajCloud: {
			region: "eu",                 // "eu" | "in" | "cn" (the domain of your SAJ portal)
			username: "you@example.com",
			password: "..."
		}
	}
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `haUrl` | `http://homeassistant.local:8123` | Home Assistant URL as seen from the MagicMirror server |
| `haToken` | `""` | Long-lived access token |
| `entities` | see below | Entity IDs; override only the ones that differ |
| `invertBatteryPower` | `false` | Set if your battery sensor is + while charging |
| `invertGridPower` | `false` | Set if your grid sensor is + while exporting |
| `idleThreshold` | `50` | W; smaller battery/grid flows show as idle (CT clamps jitter a little) |
| `batteryCapacity` | `20` | kWh |
| `updateInterval` | `30000` | ms between live updates |
| `forecastInterval` | `300000` | ms between forecast/curve updates |
| `forecastMorningHour` | `7` | Yesterday's "forecast" is Solcast's figure at this hour (later in the day Solcast converges on the actual output, so a late value says little) |
| `showChart` | `true` | Solar curve + today/tomorrow line |
| `showComparison` | `true` | "Yesterday ..." line |
| `decimalSeparator` | `"."` | `","` for European style |
| `sajCloud` | `null` | `{ region, username, password, interval (ms, default 1 h), activeHoursStart (6), activeHoursEnd (22) }` |
| `sajFinalHour` | `20` | The SAJ cloud figure counts as the day's total only if it was fetched at or after this hour |

Default `entities` (names created by `saj_h2_modbus` and Solcast):

| Key | Entity | Notes |
|---|---|---|
| `pvPower` | `sensor.saj_pv_power` | W |
| `loadPower` | `sensor.saj_total_load_power` | W |
| `batteryPower` | `sensor.saj_battery_power` | W, + = discharging |
| `batterySoc` | `sensor.saj_battery_energy_percent` | % |
| `gridPower` | `sensor.saj_ct_grid_power_total` | W, + = import. Not `saj_total_grid_power`, which is the inverter's AC output |
| `pvToday` | `sensor.saj_power_current_day` | kWh |
| `loadToday` | `sensor.saj_total_today_load` | kWh |
| `importToday` | `sensor.saj_feed_in_today_energy` | kWh; SAJ calls grid import "feed-in" |
| `exportToday` | `sensor.saj_sell_today_energy` | kWh; SAJ calls export "sell" |
| `batChargeToday` | `sensor.saj_battery_today_charge` | kWh |
| `batDischargeToday` | `sensor.saj_battery_today_discharge` | kWh |
| `forecastToday` | `sensor.solcast_pv_forecast_forecast_today` | needs the `detailedForecast` attribute (on by default) |
| `forecastTomorrow` | `sensor.solcast_pv_forecast_forecast_tomorrow` | |

## How the daily comparison works

- **Actual**: the highest value of `pvToday` yesterday (from HA history, from 00:10 to midnight, because the counter resets just after midnight).
- **Forecast**: the value of `forecastToday` at `forecastMorningHour` yesterday (from HA history).
- **SAJ app** (only with `sajCloud`): the helper asks the SAJ cloud for today's totals once an hour and keeps the last answer per day in `.saj-cloud-cache.json` in the module folder. The next day, that day's last answer is shown if it was fetched at or after `sajFinalHour`. So the SAJ figure first appears the day after installing.

## Testing without MagicMirror

```bash
cd ~/MagicMirror/modules/MMM-HA-SAJ
node test/test_driver.js ../../config/config.js          # HA only
node test/test_driver.js ../../config/config.js --saj    # also one SAJ cloud fetch now
```

It prints what the module would display. Secrets are not printed.

## Credits

Icons and the power-flow layout come from MMM-SAJ (itself inspired by [MMM-SolarEdge](https://github.com/st3v0rr/MMM-SolarEdge)). The SAJ cloud client is ported from MMM-SAJ.

## License

MIT
