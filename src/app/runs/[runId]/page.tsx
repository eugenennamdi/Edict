import RunPlanningWorkspace from "@/components/run-planning-workspace";
import { publicRunIdSchema } from "@/shared/run";

export default async function RunPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}) {
  const { runId } = await params;
  const parsed = publicRunIdSchema.safeParse(runId);
  return parsed.success
    ? <RunPlanningWorkspace initialRunId={parsed.data} />
    : <RunPlanningWorkspace invalidRunRoute />;
}
