import { resolve } from "node:path";
import { loadEventConfig } from "../dist/server/event.js";
import { artworkIssues, launchIssues, launchReport } from "../dist/server/preflight.js";

try {
	const event = await loadEventConfig();
	const issues = [
		...launchIssues(event, process.env),
		...(await artworkIssues(event, resolve(process.env.PUBLIC_DIR ?? "dist/public"))),
	];
	const report = launchReport(issues);
	for (const line of report.lines) console.log(line);
	process.exitCode = report.exitCode;
} catch {
	console.error(
		"ERROR [event-config] Cannot load a valid event config. Check EVENT_CONFIG (default event.json), JSON format and required fields. No configuration values have been logged.",
	);
	process.exitCode = 1;
}
