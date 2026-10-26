const HANDLE_GUIDANCE = "Enter your Bluesky username or handle, not a password or URL.";

export function safeHandle(value: string): string | null {
	const handle = value.trim().replace(/^@/, "").toLowerCase();
	return handle.length <= 253 &&
		/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(handle) &&
		handle.split(".").every((label) => label.length <= 63)
		? handle
		: null;
}

export function loginHandle(value: unknown): { handle: string } | { error: string } {
	if (typeof value !== "string" || value.length > 512) return { error: HANDLE_GUIDANCE };
	const input = value.trim().replace(/^@/, "").toLowerCase();
	if (input.includes("@")) return { error: HANDLE_GUIDANCE };
	const handle = safeHandle(input.includes(".") ? input : `${input}.bsky.social`);
	if (!handle) return { error: HANDLE_GUIDANCE };
	if (handle.endsWith(".bluesky.social")) {
		const suggestion = `${handle.slice(0, -".bluesky.social".length)}.bsky.social`;
		return {
			error: `Did you mean ${suggestion}? Bluesky usernames end in .bsky.social, not .bluesky.social.`,
		};
	}
	return { handle };
}
