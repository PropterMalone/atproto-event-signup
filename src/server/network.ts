import { safeFetchWrap } from "@atproto-labs/fetch-node";
import { approvedAvatarUrl } from "./policy.js";
export const safeFetch = safeFetchWrap({
	allowImplicitRedirect: true,
	ssrfProtection: true,
	allowPrivateIps: false,
	allowHttp: false,
	allowIpHost: false,
	allowData: false,
}) as typeof globalThis.fetch;

// Metadata, token responses and key sets are small documents. This allows ample
// room without admitting large Zod inputs; it is not a patch for the SDK advisory.
const sdkMaximumBytes = 128 * 1024;

function checkJsonBudget(bytes: Uint8Array): void {
	let root: unknown;
	try {
		root = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		// The SDK owns syntax/content-type validation. Never echo token contents.
		return;
	}
	const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
	let nodes = 0;
	const reject = () => {
		throw new Error("OAuth response exceeds JSON complexity limit");
	};
	while (pending.length) {
		const item = pending.pop();
		if (!item) break;
		const { value, depth } = item;
		if (++nodes > 2048 || depth > 32) reject();
		if (typeof value === "string" && value.length > 16384) reject();
		if (value && typeof value === "object") {
			if (Array.isArray(value) && value.length > 256) reject();
			const entries = Object.entries(value);
			if (nodes + pending.length + entries.length > 2048) reject();
			for (const [key, child] of entries) {
				if (key.length > 16384) reject();
				pending.push({ value: child, depth: depth + 1 });
			}
		}
	}
}

class BufferedSdkResponse extends Response {
	constructor(
		private readonly source: Response,
		body: BodyInit | null,
	) {
		super(body, { status: source.status, statusText: source.statusText, headers: source.headers });
	}
	override get url() {
		return this.source.url;
	}
	override get redirected() {
		return this.source.redirected;
	}
	override get type() {
		return this.source.type;
	}
	override clone(): Response {
		return new BufferedSdkResponse(this, super.clone().body);
	}
}

export function createSdkFetch(upstream: typeof fetch = safeFetch): typeof fetch {
	return async (input, init) => {
		const controller = new AbortController();
		const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const signal = callerSignal
			? AbortSignal.any([callerSignal, controller.signal])
			: controller.signal;
		signal.throwIfAborted();
		const timer = setTimeout(
			() => controller.abort(new DOMException("OAuth response timed out", "TimeoutError")),
			10000,
		);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let onAbort: () => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => {
				void reader?.cancel().catch(() => {});
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
		async function readResponse(): Promise<Response> {
			const response = await upstream(input, { ...init, signal });
			if (signal.aborted) {
				void response.body?.cancel().catch(() => {});
				signal.throwIfAborted();
			}
			reader = response.body?.getReader();
			if (!reader) return new BufferedSdkResponse(response, null);
			const bytes = Buffer.alloc(sdkMaximumBytes);
			let length = 0;
			for (;;) {
				const { done, value } = await reader.read();
				signal.throwIfAborted();
				if (done) break;
				if (length + value.byteLength > sdkMaximumBytes)
					throw new Error("OAuth response exceeds byte limit");
				bytes.set(value, length);
				length += value.byteLength;
			}
			const body = bytes.subarray(0, length);
			checkJsonBudget(body);
			return new BufferedSdkResponse(response, body);
		}
		try {
			// One race for the whole response avoids retaining one abort handler per chunk.
			return await Promise.race([readResponse(), aborted]);
		} catch (error) {
			controller.abort();
			void reader?.cancel().catch(() => {});
			throw error;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reader?.releaseLock();
		}
	};
}

export async function boundedBytes(
	response: Response,
	maximum: number,
): Promise<Uint8Array | null> {
	if (!response.ok || Number(response.headers.get("content-length")) > maximum) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	if (!response.body) return null;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > maximum) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}
export async function avatarSnapshot(url: string): Promise<string | null> {
	if (!approvedAvatarUrl(url)) return null;
	const response = await safeFetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
	const type = response.headers.get("content-type")?.split(";")[0];
	if (!type || !["image/jpeg", "image/png", "image/webp"].includes(type)) return null;
	const bytes = await boundedBytes(response, 512 * 1024);
	if (!bytes) return null;
	const b = Buffer.from(bytes);
	const valid =
		type === "image/png"
			? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
			: type === "image/jpeg"
				? b[0] === 255 && b[1] === 216 && b[2] === 255
				: b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
	return valid ? `data:${type};base64,${b.toString("base64")}` : null;
}
