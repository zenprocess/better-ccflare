export {
	createServerFetchHandler,
	createStartupBanner,
	default,
	type ServerHandle,
	type StartServerOptions,
} from "@ccflare/runtime-server";

import startServer from "@ccflare/runtime-server";

if (import.meta.main) {
	startServer();
}
