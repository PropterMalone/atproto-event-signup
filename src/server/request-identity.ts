import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export interface TrustedProxy {
	secret: string;
}

export function proxyFromEnvironment(): TrustedProxy | undefined {
	if (process.env.TRUST_CLOUDFLARE_TUNNEL !== "true") return undefined;
	const secret = process.env.CLOUDFLARE_ORIGIN_SECRET;
	if (!secret || secret.length < 32 || secret.length > 256)
		throw Error("Trusted tunnel requires CLOUDFLARE_ORIGIN_SECRET (32–256 characters)");
	return { secret };
}

export function requestIdentity(req: IncomingMessage, proxy?: TrustedProxy): string {
	const peer = req.socket.remoteAddress ?? "unknown";
	const provided = req.headers["x-dcbsky-proxy-secret"];
	const ip = req.headers["cf-connecting-ip"];
	if (
		proxy &&
		["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) &&
		typeof provided === "string" &&
		typeof ip === "string" &&
		isIP(ip) &&
		timingSafeEqual(
			createHash("sha256").update(provided).digest(),
			createHash("sha256").update(proxy.secret).digest(),
		)
	) {
		// Canonicalize IPv6 so alternate spellings cannot create fresh rate buckets.
		return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
	}
	return peer;
}

export function artworkSource(source: { avatar: string | null; handle: string }): string {
	return createHash("sha256")
		.update(JSON.stringify([source.avatar, source.handle]))
		.digest("hex");
}
