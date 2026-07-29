import {
	Activity,
	BarChart3,
	FileText,
	LayoutDashboard,
	Users,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { AccountsTab } from "./components/AccountsTab";
import { AnalyticsTab } from "./components/AnalyticsTab";
import { LogsTab } from "./components/LogsTab";
import { OverviewTab } from "./components/OverviewTab";
import { RequestsTab } from "./components/RequestsTab";

export interface DashboardRoute {
	path: string;
	label: string;
	icon: ComponentType<{ className?: string }>;
	title: string;
	subtitle: string;
	element: ReactNode;
}

export const dashboardRoutes: DashboardRoute[] = [
	{
		path: "/",
		label: "Overview",
		icon: LayoutDashboard,
		title: "Dashboard Overview",
		subtitle: "Monitor your ccflare performance and usage",
		element: <OverviewTab />,
	},
	{
		path: "/analytics",
		label: "Analytics",
		icon: BarChart3,
		title: "Analytics",
		subtitle: "Deep dive into your usage patterns and trends",
		element: <AnalyticsTab />,
	},
	{
		path: "/requests",
		label: "Requests",
		icon: Activity,
		title: "Request History",
		subtitle: "View detailed request and response data",
		element: <RequestsTab />,
	},
	{
		path: "/accounts",
		label: "Accounts",
		icon: Users,
		title: "Account Management",
		subtitle: "Manage provider accounts and authentication settings",
		element: <AccountsTab />,
	},
	{
		path: "/logs",
		label: "Logs",
		icon: FileText,
		title: "System Logs",
		subtitle: "Real-time system logs and debugging information",
		element: <LogsTab />,
	},
];
