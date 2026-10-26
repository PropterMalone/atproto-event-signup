import { validateOrigin } from "./policy.js";

export function readAdminDids(env: NodeJS.ProcessEnv): Set<string> {
	const value = env.ADMIN_DIDS?.trim();
	if (!value) return new Set();
	const dids = value.split(",").map((did) => did.trim());
	for (const did of dids) {
		// AT Protocol supports host-only did:web identities, not paths or ports.
		const host = did.startsWith("did:web:") ? did.slice("did:web:".length) : "";
		const supported =
			/^did:plc:[a-z2-7]{24}$/.test(did) ||
			(host.length <= 253 &&
				/^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
					host,
				));
		if (!supported)
			throw Error("ADMIN_DIDS requires comma-separated did:plc or host-only did:web identities");
	}
	return new Set(dids);
}

export function readPolicyConfig(env: NodeJS.ProcessEnv) {
	const origin = validateOrigin(env.APP_ORIGIN ?? "http://127.0.0.1:3000");
	function timestamp(name: string): number | null {
		const value = env[name];
		if (!value) return null;
		const parsed = Date.parse(value);
		if (
			!Number.isFinite(parsed) ||
			!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
		)
			throw Error(`${name} requires an ISO date with explicit timezone`);
		return parsed;
	}
	const responseCutoff = timestamp("RESPONSE_CUTOFF");
	const buttonCutoff = timestamp("BUTTON_CUTOFF");
	const artworkDeleteAt = timestamp("ARTWORK_DELETE_AT");
	if (origin.startsWith("https:") && artworkDeleteAt === null)
		throw Error("HTTPS startup requires an explicit ARTWORK_DELETE_AT");
	if (buttonCutoff !== null && artworkDeleteAt !== null && artworkDeleteAt <= buttonCutoff)
		throw Error("Artwork deletion must be after the button cutoff");
	return { origin, responseCutoff, buttonCutoff, artworkDeleteAt };
}
