import { HttpError, parseHttpError } from "./errors";

export interface RequestOptions extends RequestInit {
	timeout?: number;
	retries?: number;
	retryDelay?: number;
	baseUrl?: string;
}

export interface ClientOptions {
	baseUrl?: string;
	defaultHeaders?: HeadersInit;
	timeout?: number;
	retries?: number;
	retryDelay?: number;
}

/**
 * Base HTTP client with common retry and timeout handling.
 *
 * JSON and text responses are exposed through separate helpers so callers
 * cannot accidentally treat plain text as a typed JSON payload.
 */
export class HttpClient {
	private options: Required<ClientOptions>;

	constructor(options: ClientOptions = {}) {
		this.options = {
			baseUrl: options.baseUrl ?? "",
			defaultHeaders: options.defaultHeaders ?? {},
			timeout: options.timeout ?? 30000,
			retries: options.retries ?? 0,
			retryDelay: options.retryDelay ?? 1000,
		};
	}

	protected getJson<T = unknown>(
		url: string,
		options?: RequestOptions,
	): Promise<T> {
		return this.requestJson<T>(url, { ...options, method: "GET" });
	}

	protected postJson<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return this.requestJson<T>(url, {
			...options,
			method: "POST",
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});
	}

	protected putJson<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return this.requestJson<T>(url, {
			...options,
			method: "PUT",
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});
	}

	protected patchJson<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return this.requestJson<T>(url, {
			...options,
			method: "PATCH",
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});
	}

	protected deleteJson<T = unknown>(
		url: string,
		options?: RequestOptions,
	): Promise<T> {
		return this.requestJson<T>(url, { ...options, method: "DELETE" });
	}

	protected getText(url: string, options?: RequestOptions): Promise<string> {
		return this.requestText(url, { ...options, method: "GET" });
	}

	protected async requestJson<T = unknown>(
		url: string,
		options: RequestOptions = {},
	): Promise<T> {
		const response = await this.requestResponse(url, options);
		const text = await response.text();

		if (text.length === 0) {
			return undefined as T;
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			throw new HttpError(
				500,
				`Expected JSON response but received '${contentType || "unknown"}'`,
			);
		}

		try {
			return JSON.parse(text) as T;
		} catch {
			throw new HttpError(500, "Failed to parse JSON response");
		}
	}

	protected async requestText(
		url: string,
		options: RequestOptions = {},
	): Promise<string> {
		const response = await this.requestResponse(url, options);
		return response.text();
	}

	private async requestResponse(
		url: string,
		options: RequestOptions = {},
	): Promise<Response> {
		const {
			timeout = this.options.timeout,
			retries = this.options.retries,
			retryDelay = this.options.retryDelay,
			baseUrl = this.options.baseUrl,
			...fetchOptions
		} = options;

		const fullUrl = baseUrl ? new URL(url, baseUrl).toString() : url;
		const headers = {
			...this.options.defaultHeaders,
			...fetchOptions.headers,
		};

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeout);

				const response = await fetch(fullUrl, {
					...fetchOptions,
					headers,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					throw await parseHttpError(response);
				}

				return response;
			} catch (error) {
				lastError = error as Error;

				if (error instanceof HttpError && error.status < 500) {
					throw error;
				}

				if (error instanceof Error && error.name === "AbortError") {
					throw new HttpError(408, "Request timeout");
				}

				if (attempt < retries) {
					await this.delay(retryDelay * (attempt + 1));
				}
			}
		}

		throw lastError || new Error("Unknown error");
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
