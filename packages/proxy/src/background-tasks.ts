const backgroundTasks = new Set<Promise<void>>();

export function trackProxyBackgroundTask(task: Promise<void>): void {
	let trackedTask: Promise<void> | null = null;
	trackedTask = task.finally(() => {
		if (trackedTask) {
			backgroundTasks.delete(trackedTask);
		}
	});
	backgroundTasks.add(trackedTask);
}

export async function waitForProxyBackgroundTasks(): Promise<void> {
	while (backgroundTasks.size > 0) {
		await Promise.allSettled(Array.from(backgroundTasks));
	}
}
