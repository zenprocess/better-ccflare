// @ts-nocheck — harness helper, runs under Bun.
/**
 * Local HTTP server used by bun-35093-harness.ts.
 * Responds with a fixed 100 KB body and `connection: close` to avoid TCP-buffer
 * accumulation across many client requests.
 */
const PORT = Number(process.env.HARNESS_PORT ?? process.env.PORT ?? 17821);
const SIZE = Number(process.env.BODY_SIZE ?? 100 * 1024);
const buf = new Uint8Array(SIZE);
for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
Bun.serve({
	port: PORT,
	fetch(_req) {
		return new Response(buf, {
			headers: {
				"content-type": "application/octet-stream",
				"content-length": String(buf.length),
				"connection": "close",
			},
		});
	},
});
console.log(`listening ${PORT}`);