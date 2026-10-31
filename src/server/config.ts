import { validateOrigin } from "./policy.js";

export interface EventConfig {
	$schema?: string;
	name: string;
	community: string;
	tagline: string;
	description: string;
	origin: string;
	startAt: string;
	endAt: string;
	timeZone: string;
	locale: string;
	calendarUid: string;
	venue: { name: string; address: string; url: string };
	branding: {
		name: string;
		shortName: string;
		color: string;
		mark: string;
		markAlt: string;
		favicon: string;
		favicon32: string;
		appleTouchIcon: string;
		icon192: string;
		icon512: string;
		socialImage: string;
		socialImageAlt: string;
		socialImageWidth: number;
		socialImageHeight: number;
	};
}

export function parseEventConfig(input: unknown): EventConfig {
	function object(
		value: unknown,
		label: string,
		fields: readonly string[],
	): Record<string, unknown> {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw Error(`Event config ${label} must be an object`);
		if (Object.keys(value).some((field) => !fields.includes(field)))
			throw Error(`Event config ${label} contains unknown fields`);
		return value as Record<string, unknown>;
	}
	function text(value: unknown, label: string): string {
		if (
			typeof value !== "string" ||
			!value.trim() ||
			value.length > 2000 ||
			Array.from(value).some(
				(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			)
		)
			throw Error(`Event config ${label} must be nonempty text without control characters`);
		return value;
	}
	const root = object(input, "root", [
		"$schema",
		"name",
		"community",
		"tagline",
		"description",
		"origin",
		"startAt",
		"endAt",
		"timeZone",
		"locale",
		"calendarUid",
		"venue",
		"branding",
	]);
	const venue = object(root.venue, "venue", ["name", "address", "url"]);
	const branding = object(root.branding, "branding", [
		"name",
		"shortName",
		"color",
		"mark",
		"markAlt",
		"favicon",
		"favicon32",
		"appleTouchIcon",
		"icon192",
		"icon512",
		"socialImage",
		"socialImageAlt",
		"socialImageWidth",
		"socialImageHeight",
	]);
	const values: Record<string, string> = {};
	for (const field of [
		"name",
		"community",
		"tagline",
		"description",
		"origin",
		"startAt",
		"endAt",
		"timeZone",
		"locale",
		"calendarUid",
	])
		values[field] = text(root[field], field);
	validateOrigin(values.origin ?? "");
	for (const field of ["startAt", "endAt"]) {
		const value = values[field] ?? "";
		if (
			!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
				value,
			) ||
			!Number.isFinite(Date.parse(value)) ||
			new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)
		)
			throw Error(`Event config ${field} requires an ISO timestamp with explicit timezone`);
	}
	if (Date.parse(values.endAt ?? "") <= Date.parse(values.startAt ?? ""))
		throw Error("Event config endAt must be after startAt");
	try {
		new Intl.DateTimeFormat(values.locale, { timeZone: values.timeZone }).format(
			new Date(values.startAt ?? ""),
		);
	} catch {
		throw Error("Event config requires a valid locale and IANA timeZone");
	}
	const venueValues = {
		name: text(venue.name, "venue.name"),
		address: text(venue.address, "venue.address"),
		url: text(venue.url, "venue.url"),
	};
	const venueUrl = new URL(venueValues.url);
	if (venueUrl.protocol !== "https:" || venueUrl.username || venueUrl.password)
		throw Error("Event config venue.url must be a public HTTPS URL");
	const brandValues: Record<string, string | number> = {};
	for (const field of [
		"name",
		"shortName",
		"color",
		"mark",
		"markAlt",
		"favicon",
		"favicon32",
		"appleTouchIcon",
		"icon192",
		"icon512",
		"socialImage",
		"socialImageAlt",
	])
		brandValues[field] = text(branding[field], `branding.${field}`);
	if (!/^#[a-f0-9]{6}$/i.test(String(brandValues.color)))
		throw Error("Event config branding.color must be a six-digit hex color");
	for (const field of [
		"mark",
		"favicon",
		"favicon32",
		"appleTouchIcon",
		"icon192",
		"icon512",
		"socialImage",
	]) {
		const path = String(brandValues[field]);
		if (!/^\/[a-zA-Z0-9_-]+\.(?:svg|png)$/.test(path))
			throw Error(`Event config branding.${field} must name a root-level public PNG or SVG asset`);
	}
	if (!String(brandValues.favicon).endsWith(".svg"))
		throw Error("Event config branding.favicon must be SVG");
	for (const field of ["favicon32", "appleTouchIcon", "icon192", "icon512"])
		if (!String(brandValues[field]).endsWith(".png"))
			throw Error(`Event config branding.${field} must be PNG`);
	if (!String(brandValues.socialImage).endsWith(".png"))
		throw Error("Event config branding.socialImage must be PNG");
	for (const field of ["socialImageWidth", "socialImageHeight"]) {
		const value = branding[field];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4096)
			throw Error(`Event config branding.${field} must be an integer between 1 and 4096`);
		brandValues[field] = value;
	}
	return {
		...values,
		...(root.$schema === undefined ? {} : { $schema: text(root.$schema, "$schema") }),
		venue: venueValues,
		branding: brandValues,
	} as unknown as EventConfig;
}

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
