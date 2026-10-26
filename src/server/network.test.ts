import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { avatarSnapshot, boundedBytes, createSdkFetch } from "./network.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("caps decompressed bytes from real fetch even when compressed Content-Length is small", async () => {
	const compressed = gzipSync("x".repeat(128 * 1024 + 1));
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
		response.end(compressed);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test address");
		// Inject native fetch for this loopback-only transport test; production defaults to safeFetch.
		await expect(createSdkFetch(fetch)(`http://127.0.0.1:${address.port}`)).rejects.toThrow(
			"OAuth response exceeds byte limit",
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

function fetchResponse(response: Response) {
	return vi.fn<typeof fetch>().mockResolvedValue(response);
}

it.each([
	undefined,
	"1",
	"999999",
])("caps actual bytes without trusting content-length %s and cancels overflow", async (length) => {
	const cancel = vi.fn();
	let chunks = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			chunks++;
			controller.enqueue(new Uint8Array(32 * 1024));
		},
		cancel,
	});
	const headers = length ? { "content-length": length } : undefined;
	const wrapped = createSdkFetch(fetchResponse(new Response(body, headers ? { headers } : {})));
	await expect(wrapped("https://example.com")).rejects.toThrow("OAuth response exceeds byte limit");
	expect(cancel).toHaveBeenCalledOnce();
	expect(chunks).toBeLessThanOrEqual(6);
});

it("accepts the exact byte bound and ignores a falsely large length", async () => {
	const text = "x".repeat(128 * 1024);
	const wrapped = createSdkFetch(
		fetchResponse(new Response(text, { headers: { "content-length": "999999" } })),
	);
	expect(await (await wrapped("https://example.com")).text()).toBe(text);
});

it("preserves raw JSON, headers, status, response URL and cloned response metadata", async () => {
	const text = '{ "duplicate": 1, "duplicate": 2, "__proto__": {"x": true}, "n": 1e3 }';
	const upstream = new Response(text, {
		status: 400,
		statusText: "Nonce needed",
		headers: {
			"dpop-nonce": "nonce",
			"content-type": "application/json",
			"www-authenticate": "DPoP",
		},
	});
	Object.defineProperties(upstream, {
		url: { value: "https://example.com/final" },
		redirected: { value: true },
	});
	const wrapped = createSdkFetch(fetchResponse(upstream));
	const response = await wrapped("https://example.com");
	expect(response.status).toBe(400);
	expect(response.statusText).toBe("Nonce needed");
	expect(response.headers.get("dpop-nonce")).toBe("nonce");
	expect(response.headers.get("www-authenticate")).toBe("DPoP");
	expect(response.url).toBe(upstream.url);
	expect(response.redirected).toBe(true);
	expect(response.clone().url).toBe(upstream.url);
	expect(await response.text()).toBe(text);
});

it.each([
	"not json",
	"",
	'{"broken":',
	"null",
	'"text"',
])("leaves bounded malformed or scalar responses to the SDK: %s", async (text) => {
	const wrapped = createSdkFetch(fetchResponse(new Response(text)));
	expect(await (await wrapped("https://example.com")).text()).toBe(text);
});

it.each([
	JSON.stringify({ supported: Array(257).fill("x") }),
	JSON.stringify({ secret: "s".repeat(16385) }),
	`${"[".repeat(33)}0${"]".repeat(33)}`,
	JSON.stringify(Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [i, null]))),
])("rejects JSON complexity before SDK validation without including content in errors", async (text) => {
	const wrapped = createSdkFetch(fetchResponse(new Response(text)));
	await expect(wrapped("https://example.com")).rejects.toThrow(
		/^OAuth response exceeds JSON complexity limit$/,
	);
});

it("accepts ordinary JSON metadata and token-sized strings within the structural budgets", async () => {
	const text = JSON.stringify({
		issuer: "https://example.com",
		supported: Array(256).fill("ES256"),
		access_token: "x".repeat(16384),
	});
	const response = await createSdkFetch(fetchResponse(new Response(text)))("https://example.com");
	expect(await response.text()).toBe(text);
});

it("cancels a body whose headers arrive after caller cancellation", async () => {
	const caller = new AbortController();
	let finish: (response: Response) => void = () => {};
	const upstream = vi.fn<typeof fetch>(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	);
	const result = createSdkFetch(upstream)("https://example.com", { signal: caller.signal });
	const assertion = expect(result).rejects.toThrow();
	caller.abort();
	await assertion;
	const cancel = vi.fn();
	finish(new Response(new ReadableStream({ cancel })));
	await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it("does not start fetch for an already-aborted Request", async () => {
	const caller = new AbortController();
	caller.abort();
	const upstream = fetchResponse(new Response("unused"));
	await expect(
		createSdkFetch(upstream)(new Request("https://example.com", { signal: caller.signal })),
	).rejects.toThrow();
	expect(upstream).not.toHaveBeenCalled();
});

it("covers stalled headers with a deadline and aborts the underlying fetch", async () => {
	vi.useFakeTimers();
	let signal: AbortSignal | null | undefined;
	const upstream = vi.fn<typeof fetch>((_input, init) => {
		signal = init?.signal;
		return new Promise(() => {});
	});
	const result = createSdkFetch(upstream)("https://example.com");
	const assertion = expect(result).rejects.toThrow();
	await vi.advanceTimersByTimeAsync(10001);
	await assertion;
	expect(signal?.aborted).toBe(true);
});

it("covers stalled bodies with the same deadline and cancels their reader", async () => {
	vi.useFakeTimers();
	const cancel = vi.fn();
	const upstream = fetchResponse(new Response(new ReadableStream({ cancel })));
	const result = createSdkFetch(upstream)("https://example.com");
	const assertion = expect(result).rejects.toThrow();
	await vi.advanceTimersByTimeAsync(10001);
	await assertion;
	expect(upstream.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	expect(cancel).toHaveBeenCalledOnce();
});

it("honors Request signals and init overrides, including cancellation during body read", async () => {
	const requestAbort = new AbortController();
	requestAbort.abort();
	const caller = new AbortController();
	const cancel = vi.fn();
	const upstream = fetchResponse(new Response(new ReadableStream({ cancel })));
	const result = createSdkFetch(upstream)(
		new Request("https://example.com", { signal: requestAbort.signal, redirect: "manual" }),
		{ signal: caller.signal },
	);
	const assertion = expect(result).rejects.toThrow();
	await vi.waitFor(() => expect(upstream.mock.results[0]?.value).toBeDefined());
	caller.abort();
	await assertion;
	expect(cancel).toHaveBeenCalledOnce();
});

it("preserves caller redirect policy and never substitutes an unguarded fetch", async () => {
	const upstream = fetchResponse(new Response(null, { status: 204 }));
	const request = new Request("https://example.com", {
		redirect: "manual",
		headers: { dpop: "proof" },
	});
	const response = await createSdkFetch(upstream)(request);
	expect(response.status).toBe(204);
	expect(upstream.mock.calls[0]?.[0]).toBe(request);
	expect(upstream.mock.calls[0]?.[1]?.redirect).toBeUndefined();
	expect(request.headers.get("dpop")).toBe("proof");
});
it("bounds external response bodies even with a lying or missing length", async () => {
	expect(await boundedBytes(new Response("ok"), 4)).toEqual(Buffer.from("ok"));
	expect(await boundedBytes(new Response("12345"), 4)).toBeNull();
	expect(
		await boundedBytes(new Response("x", { headers: { "content-length": "100" } }), 4),
	).toBeNull();
	expect(await boundedBytes(new Response(null), 4)).toBeNull();
	expect(await boundedBytes(new Response("no", { status: 404 }), 4)).toBeNull();
});
it("refuses arbitrary avatar endpoints and private network OAuth fetches", async () => {
	expect(await avatarSnapshot("http://127.0.0.1/x")).toBeNull();
	const { safeFetch } = await import("./network.js");
	await expect(safeFetch("http://127.0.0.1:9")).rejects.toThrow();
});
