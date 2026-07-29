const PROVIDER_PREFIX_RE =
	/^(anthropic|openai|codex|claude-code|google|xai|zai)\//;
const DATE_SUFFIX_RE = /-\d{8}$/;
const LATEST_SUFFIX_RE = /-latest$/;

function normalizeModelId(modelId: string): string {
	return modelId
		.trim()
		.replace(PROVIDER_PREFIX_RE, "")
		.replace(LATEST_SUFFIX_RE, "")
		.replace(DATE_SUFFIX_RE, "");
}

export function getModelShortName(modelId: string): string {
	const normalized = normalizeModelId(modelId);
	return normalized || modelId;
}
