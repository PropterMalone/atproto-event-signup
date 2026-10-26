import { normalizeButtonLabel } from "../shared/button.js";
import type { ResponseInput } from "../shared/types.js";
export function parseResponse(value: unknown): ResponseInput | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).some(
			(key) =>
				![
					"attendance",
					"button",
					"replaceArtwork",
					"futureMeetups",
					"label",
					"position",
					"color",
				].includes(key),
		)
	)
		return null;
	if (
		![null, "coming", "maybe", "cant"].includes(row.attendance as string | null) ||
		![null, "handle", "pfp"].includes(row.button as string | null)
	)
		return null;
	if (row.position !== undefined && row.position !== "top" && row.position !== "bottom")
		return null;
	if (row.color !== undefined && row.color !== "white" && row.color !== "black") return null;
	if (row.futureMeetups !== undefined && typeof row.futureMeetups !== "boolean") return null;
	if (row.replaceArtwork !== undefined && typeof row.replaceArtwork !== "boolean") return null;
	if (row.label !== undefined) {
		if (typeof row.label !== "string") return null;
		const label = normalizeButtonLabel(row.label);
		if (!label) return null;
		return { ...row, label } as unknown as ResponseInput;
	}
	return row as unknown as ResponseInput;
}
export { safeHandle } from "../shared/handle.js";
export function approvedAvatarUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return (
			u.protocol === "https:" &&
			u.hostname === "cdn.bsky.app" &&
			!u.port &&
			!u.username &&
			!u.password &&
			!u.search &&
			!u.hash &&
			u.pathname.startsWith("/img/avatar/")
		);
	} catch {
		return false;
	}
}
export function validateOrigin(origin: string): string {
	const u = new URL(origin);
	if (
		u.origin !== origin ||
		u.username ||
		u.password ||
		(u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "127.0.0.1"))
	)
		throw new Error(
			"APP_ORIGIN must be an HTTPS origin, or http://127.0.0.1:PORT for local development",
		);
	return origin;
}
