import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type EventConfig, readAdminDids, readPolicyConfig } from "./config.js";

interface LaunchIssue {
	level: "error" | "warning";
	code: string;
	message: string;
}

export function launchReport(issues: LaunchIssue[]): { lines: string[]; exitCode: number } {
	const errors = issues.filter((issue) => issue.level === "error").length;
	return {
		lines: [
			...issues.map((issue) => `${issue.level.toUpperCase()} [${issue.code}] ${issue.message}`),
			`Pre-launch check: ${errors} blocker(s), ${issues.length - errors} warning(s).`,
			"This is a local config/asset check, not an OAuth, backup-restore, dependency-audit or trademark approval check.",
		],
		exitCode: errors ? 1 : 0,
	};
}

function placeholderHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		["example.com", "example.net", "example.org", "example", "invalid", "test", "localhost"].some(
			(domain) => host === domain || host.endsWith(`.${domain}`),
		) ||
		host === "127.0.0.1" ||
		host === "[::1]"
	);
}

export function launchIssues(
	event: EventConfig,
	env: NodeJS.ProcessEnv,
	now = Date.now(),
): LaunchIssue[] {
	const issues: LaunchIssue[] = [];
	function add(level: LaunchIssue["level"], code: string, message: string) {
		issues.push({ level, code, message });
	}
	for (const [field, value] of [
		["event.origin", event.origin],
		["venue.url", event.venue.url],
		["APP_ORIGIN", env.APP_ORIGIN ?? event.origin],
	]) {
		try {
			const url = new URL(value ?? "");
			if (placeholderHost(url.hostname))
				add(
					"error",
					"placeholder-url",
					`${field} uses a placeholder or loopback hostname. Configure the real public URL.`,
				);
			if (field !== "venue.url" && url.protocol !== "https:")
				add("error", "https-required", `${field} must use HTTPS for launch.`);
		} catch {
			add("error", "invalid-url", `${field} is not a valid URL.`);
		}
	}
	if (env.APP_ORIGIN && env.APP_ORIGIN !== event.origin)
		add(
			"warning",
			"origin-mismatch",
			"APP_ORIGIN differs from event.origin. The built social-card hostname comes from event.origin; align them and rebuild for launch.",
		);
	const sampleFields = [
		event.name,
		event.community,
		event.description,
		event.tagline,
		event.venue.name,
		event.venue.address,
	];
	if (
		sampleFields.some((value) =>
			/Hill Valley|Doc Brown|1640 Riverside Drive|Back to the Future/i.test(value),
		)
	)
		add(
			"warning",
			"sample-copy",
			"Event copy still contains fictional sample details. Review the event name, community, description and venue before sharing.",
		);
	if (Date.parse(event.endAt) <= now)
		add(
			"error",
			"event-ended",
			"The event endAt is in the past. Set the real event dates before launching registration.",
		);
	try {
		if (readAdminDids(env).size === 0)
			add(
				"error",
				"no-organizer",
				"ADMIN_DIDS is empty. Configure at least one verified organizer DID.",
			);
	} catch {
		add(
			"error",
			"invalid-organizer",
			"ADMIN_DIDS contains an invalid DID. Use verified did:plc or host-only did:web identities.",
		);
	}
	if (!env.ARTWORK_DELETE_AT)
		add(
			"error",
			"missing-retention",
			"Set an explicit ARTWORK_DELETE_AT and agree on the retention deadline before launch.",
		);
	try {
		const policy = readPolicyConfig({ ...env, APP_ORIGIN: env.APP_ORIGIN ?? event.origin });
		if (policy.artworkDeleteAt !== null) {
			if (policy.artworkDeleteAt <= now)
				add(
					"error",
					"retention-expired",
					"ARTWORK_DELETE_AT has already passed; artwork requests would be closed or immediately deleted.",
				);
			if (policy.artworkDeleteAt <= Date.parse(event.endAt))
				add(
					"error",
					"retention-before-event-end",
					"ARTWORK_DELETE_AT must be after the event ends for this launch workflow.",
				);
		}
		for (const [field, value] of [
			["RESPONSE_CUTOFF", policy.responseCutoff],
			["BUTTON_CUTOFF", policy.buttonCutoff],
		] as const) {
			if (value !== null && value <= now)
				add(
					"warning",
					"cutoff-passed",
					`${field} has already passed. New or changed event choices may be closed.`,
				);
			if (value !== null && value > Date.parse(event.endAt))
				add(
					"warning",
					"cutoff-after-event",
					`${field} is after the event ends. Confirm that late changes are intended.`,
				);
		}
	} catch {
		if (env.ARTWORK_DELETE_AT)
			add(
				"error",
				"invalid-policy",
				"Check APP_ORIGIN and the policy timestamps: use explicit ISO timezones and set artwork deletion after BUTTON_CUTOFF.",
			);
	}
	add(
		"warning",
		"retention-scope",
		"Artwork deletion does not erase attendance or future-contact preferences. Agree on their separate retention and apply deadlines to backups and exports.",
	);
	return issues;
}

export async function artworkIssues(
	event: EventConfig,
	publicDirectory: string,
): Promise<LaunchIssue[]> {
	const issues: LaunchIssue[] = [];
	const assets = [
		{ field: "branding.mark", path: event.branding.mark },
		{ field: "branding.favicon", path: event.branding.favicon },
		{ field: "branding.favicon32", path: event.branding.favicon32, width: 32, height: 32 },
		{
			field: "branding.appleTouchIcon",
			path: event.branding.appleTouchIcon,
			width: 180,
			height: 180,
		},
		{ field: "branding.icon192", path: event.branding.icon192, width: 192, height: 192 },
		{ field: "branding.icon512", path: event.branding.icon512, width: 512, height: 512 },
		{
			field: "branding.socialImage",
			path: event.branding.socialImage,
			width: event.branding.socialImageWidth,
			height: event.branding.socialImageHeight,
		},
	];
	for (const asset of assets) {
		try {
			const path = join(publicDirectory, asset.path.slice(1));
			const info = await stat(path);
			if (!info.isFile() || info.size === 0 || info.size > 8 * 1024 * 1024) {
				issues.push({
					level: "error",
					code: "invalid-artwork",
					message: `${asset.field} must be a nonempty image file no larger than 8 MiB.`,
				});
				continue;
			}
			const bytes = await readFile(path);
			if (asset.path.endsWith(".png")) {
				if (
					bytes.length < 45 ||
					!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
					bytes.readUInt32BE(8) !== 13 ||
					bytes.toString("ascii", 12, 16) !== "IHDR" ||
					bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
				) {
					issues.push({
						level: "error",
						code: "invalid-artwork",
						message: `${asset.field} does not have valid PNG header/end markers. Replace it and rebuild.`,
					});
					continue;
				}
				const width = bytes.readUInt32BE(16);
				const height = bytes.readUInt32BE(20);
				if (
					width === 0 ||
					height === 0 ||
					(asset.width !== undefined && (width !== asset.width || height !== asset.height))
				)
					issues.push({
						level: "error",
						code: "artwork-dimensions",
						message: `${asset.field} dimensions do not match the configured or required icon size. Replace it or correct the config and rebuild.`,
					});
			} else if (
				!/<svg(?:\s|>)/i.test(bytes.toString("utf8")) ||
				!/<\/svg\s*>|<svg[^>]*\/>/i.test(bytes.toString("utf8"))
			) {
				issues.push({
					level: "error",
					code: "invalid-artwork",
					message: `${asset.field} does not have SVG markup. Replace it and rebuild.`,
				});
			}
		} catch {
			issues.push({
				level: "error",
				code: "missing-artwork",
				message: `${asset.field} is missing or unreadable in PUBLIC_DIR (default dist/public). Build and verify the deployment assets.`,
			});
		}
	}
	return issues;
}
