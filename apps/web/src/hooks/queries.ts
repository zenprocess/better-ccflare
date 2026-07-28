import type { AccountProvider, TimeRange } from "@ccflare/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { REFRESH_INTERVALS } from "../constants";
import { queryKeys } from "../lib/query-keys";

export const useAccounts = () => {
	return useQuery({
		queryKey: queryKeys.accounts(),
		queryFn: () => api.getAccounts(),
		refetchInterval: REFRESH_INTERVALS.fast, // Refresh every 10 seconds for rate limit updates
	});
};

export const useStats = (refetchInterval?: number) => {
	return useQuery({
		queryKey: queryKeys.stats(),
		queryFn: () => api.getStats(),
		refetchInterval: refetchInterval ?? REFRESH_INTERVALS.fast,
	});
};

export const useAnalytics = (
	timeRange: TimeRange,
	filters: {
		providers?: AccountProvider[];
		accounts?: string[];
		models?: string[];
		status?: "all" | "success" | "error";
	},
	viewMode: "normal" | "cumulative",
	modelBreakdown?: boolean,
) => {
	return useQuery({
		queryKey: queryKeys.analytics(timeRange, filters, viewMode, modelBreakdown),
		queryFn: () =>
			api.getAnalytics(timeRange, filters, viewMode, modelBreakdown),
	});
};

export const useLogHistory = () => {
	return useQuery({
		queryKey: queryKeys.logHistory(),
		queryFn: () => api.getLogHistory(),
	});
};

// Mutations
export const useRemoveAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ accountId }: { accountId: string }) =>
			api.removeAccount(accountId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useRenameAccount = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			accountId,
			newName,
		}: {
			accountId: string;
			newName: string;
		}) => api.renameAccount(accountId, newName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });
		},
	});
};

export const useResetStats = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.resetStats(),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
		},
	});
};

// Retention settings
export const useRetention = () => {
	return useQuery({
		queryKey: ["retention"],
		queryFn: () => api.getRetention(),
	});
};

export const useSetRetention = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (partial: { payloadDays?: number; requestDays?: number }) =>
			api.setRetention(partial),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["retention"] });
		},
	});
};

export const useCleanupNow = () => {
	return useMutation({
		mutationFn: () => api.cleanupNow(),
	});
};

export const useCompactDb = () => {
	return useMutation({
		mutationFn: () => api.compactDb(),
	});
};
