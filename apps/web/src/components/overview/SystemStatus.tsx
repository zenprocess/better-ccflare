import {
	AlertTriangle,
	CheckCircle,
	ExternalLink,
	Loader2,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

interface SystemStatusProps {
	recentErrors?: string[];
}

type ProviderHealth = "operational" | "degraded" | "outage" | "unknown";

interface ProviderStatus {
	name: string;
	status: ProviderHealth;
	description: string;
	incidents: { name: string; status: string }[];
	url: string;
}

function statusIcon(status: ProviderHealth) {
	switch (status) {
		case "operational":
			return <CheckCircle className="h-4 w-4 text-success" />;
		case "degraded":
			return <AlertTriangle className="h-4 w-4 text-warning" />;
		case "outage":
			return <XCircle className="h-4 w-4 text-destructive" />;
		default:
			return <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />;
	}
}

function statusBadge(status: ProviderHealth) {
	switch (status) {
		case "operational":
			return <Badge variant="success">Operational</Badge>;
		case "degraded":
			return <Badge variant="warning">Degraded</Badge>;
		case "outage":
			return <Badge variant="destructive">Outage</Badge>;
		default:
			return <Badge variant="outline">Unknown</Badge>;
	}
}

function mapAnthropicStatus(indicator: string): ProviderHealth {
	switch (indicator) {
		case "none":
			return "operational";
		case "minor":
		case "major":
			return "degraded";
		case "critical":
			return "outage";
		default:
			return "unknown";
	}
}

function mapOpenAIStatus(
	incidents: { status: string }[],
	components: { status: string }[],
): ProviderHealth {
	if (incidents.length === 0 && components.every((c) => !c.status)) {
		return "operational";
	}
	const hasInvestigating = incidents.some(
		(i) => i.status === "investigating" || i.status === "identified",
	);
	if (hasInvestigating) return "outage";
	if (incidents.length > 0) return "degraded";
	return "operational";
}

function useProviderStatuses() {
	const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;

		async function fetchStatuses() {
			const results: ProviderStatus[] = [];

			// Anthropic (Statuspage Atlassian JSON API)
			try {
				const res = await fetch("https://status.claude.com/api/v2/status.json");
				if (res.ok) {
					const data = await res.json();
					const indicator: string = data.status?.indicator ?? "unknown";
					const description: string =
						data.status?.description ?? "Unknown status";

					// Also fetch incidents
					let incidents: { name: string; status: string }[] = [];
					try {
						const incRes = await fetch(
							"https://status.claude.com/api/v2/incidents/unresolved.json",
						);
						if (incRes.ok) {
							const incData = await incRes.json();
							incidents = (incData.incidents ?? []).map(
								(i: { name: string; status: string }) => ({
									name: i.name,
									status: i.status,
								}),
							);
						}
					} catch {
						// ignore incident fetch failure
					}

					results.push({
						name: "Anthropic",
						status: mapAnthropicStatus(indicator),
						description,
						incidents,
						url: "https://status.claude.com",
					});
				}
			} catch {
				results.push({
					name: "Anthropic",
					status: "unknown",
					description: "Unable to fetch status",
					incidents: [],
					url: "https://status.claude.com",
				});
			}

			// OpenAI (incident.io JSON API)
			try {
				const res = await fetch(
					"https://status.openai.com/proxy/status.openai.com",
				);
				if (res.ok) {
					const data = await res.json();
					const summary = data.summary;
					const ongoingIncidents: {
						name: string;
						status: string;
					}[] = (summary?.ongoing_incidents ?? []).map(
						(i: { name: string; status: string }) => ({
							name: i.name,
							status: i.status,
						}),
					);

					const affectedComponents: { status: string }[] =
						summary?.affected_components ?? [];

					results.push({
						name: "OpenAI",
						status: mapOpenAIStatus(ongoingIncidents, affectedComponents),
						description:
							ongoingIncidents.length > 0
								? `${ongoingIncidents.length} ongoing incident${ongoingIncidents.length > 1 ? "s" : ""}`
								: "All Systems Operational",
						incidents: ongoingIncidents,
						url: "https://status.openai.com",
					});
				}
			} catch {
				results.push({
					name: "OpenAI",
					status: "unknown",
					description: "Unable to fetch status",
					incidents: [],
					url: "https://status.openai.com",
				});
			}

			if (!cancelled) {
				setStatuses(results);
				setLoading(false);
			}
		}

		fetchStatuses();

		// Refresh every 60 seconds
		const interval = setInterval(fetchStatuses, 60_000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	return { statuses, loading };
}

export function SystemStatus({ recentErrors }: SystemStatusProps) {
	const { statuses, loading } = useProviderStatuses();

	return (
		<Card>
			<CardHeader>
				<CardTitle>System Status</CardTitle>
				<CardDescription>
					Current operational status and recent events
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					<div className="flex items-center justify-between p-4 rounded-lg bg-success/10">
						<div className="flex items-center gap-3">
							<CheckCircle className="h-5 w-5 text-success" />
							<div>
								<p className="font-medium">All Systems Operational</p>
								<p className="text-sm text-muted-foreground">
									No issues detected
								</p>
							</div>
						</div>
						<Badge variant="default" className="bg-success">
							Healthy
						</Badge>
					</div>

					{/* Provider Status */}
					<div className="space-y-2">
						<h4 className="text-sm font-medium text-muted-foreground">
							Provider Status
						</h4>
						{loading ? (
							<div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
								<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
								<p className="text-sm text-muted-foreground">
									Checking provider status...
								</p>
							</div>
						) : (
							statuses.map((provider) => (
								<div key={provider.name} className="space-y-1">
									<div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
										<div className="flex items-center gap-2">
											{statusIcon(provider.status)}
											<span className="text-sm font-medium">
												{provider.name}
											</span>
											<span className="text-xs text-muted-foreground">
												{provider.description}
											</span>
										</div>
										<div className="flex items-center gap-2">
											{statusBadge(provider.status)}
											<a
												href={provider.url}
												target="_blank"
												rel="noopener noreferrer"
												className="text-muted-foreground hover:text-foreground"
											>
												<ExternalLink className="h-3.5 w-3.5" />
											</a>
										</div>
									</div>
									{provider.incidents.length > 0 && (
										<div className="ml-6 space-y-1">
											{provider.incidents.slice(0, 3).map((incident) => (
												<div
													key={incident.name}
													className="flex items-start gap-2 px-3 py-1.5 rounded text-xs"
												>
													<AlertTriangle className="h-3 w-3 text-warning mt-0.5 shrink-0" />
													<span className="text-muted-foreground">
														{incident.name}
													</span>
												</div>
											))}
										</div>
									)}
								</div>
							))
						)}
					</div>

					{recentErrors && recentErrors.length > 0 && (
						<div className="space-y-2">
							<h4 className="text-sm font-medium text-muted-foreground">
								Recent Errors
							</h4>
							{recentErrors.slice(0, 3).map((error) => (
								<div
									key={`error-${error}`}
									className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10"
								>
									<XCircle className="h-4 w-4 text-destructive mt-0.5" />
									<p className="text-sm text-muted-foreground">{error}</p>
								</div>
							))}
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
