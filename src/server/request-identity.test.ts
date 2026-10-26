import type { IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { proxyFromEnvironment, requestIdentity } from "./request-identity.js";

const secret = "s".repeat(32);
const request = (peer: string, headers: Record<string, string | string[]>) =>
	({ socket: { remoteAddress: peer }, headers }) as IncomingMessage;
afterEach(() => vi.unstubAllEnvs());
it("requires explicit tunnel mode and a bounded origin secret", () => {
	vi.stubEnv("TRUST_CLOUDFLARE_TUNNEL", "false");
	vi.stubEnv("CLOUDFLARE_ORIGIN_SECRET", secret);
	expect(proxyFromEnvironment()).toBeUndefined();
	vi.stubEnv("TRUST_CLOUDFLARE_TUNNEL", "true");
	expect(proxyFromEnvironment()).toEqual({ secret });
	for (const value of ["", "short", "s".repeat(257)]) {
		vi.stubEnv("CLOUDFLARE_ORIGIN_SECRET", value);
		expect(proxyFromEnvironment).toThrow("CLOUDFLARE_ORIGIN_SECRET");
	}
});
it("ignores spoofed forwarding on direct and nonloopback requests and rejects malformed IPs", () => {
	const headers = {
		"cf-connecting-ip": "198.51.100.1",
		"x-dcbsky-proxy-secret": secret,
		"x-forwarded-for": "198.51.100.2",
	};
	expect(requestIdentity(request("127.0.0.1", headers))).toBe("127.0.0.1");
	expect(requestIdentity(request("203.0.113.1", headers), { secret })).toBe("203.0.113.1");
	for (const ip of ["not-an-ip", "198.51.100.1, 198.51.100.2", ""]) {
		expect(
			requestIdentity(request("127.0.0.1", { ...headers, "cf-connecting-ip": ip }), { secret }),
		).toBe("127.0.0.1");
	}
	expect(
		requestIdentity(request("::1", { ...headers, "x-dcbsky-proxy-secret": [secret, secret] }), {
			secret,
		}),
	).toBe("::1");
	expect(
		requestIdentity(request("::1", { ...headers, "cf-connecting-ip": "2001:0db8:0:0::1" }), {
			secret,
		}),
	).toBe("[2001:db8::1]");
	expect(requestIdentity(request("::ffff:127.0.0.1", headers), { secret })).toBe("198.51.100.1");
});
