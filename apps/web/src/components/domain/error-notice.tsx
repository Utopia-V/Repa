import { StatusNotice } from "@/components/ui/status-notice";
import { describeError } from "@/lib/errors";

export function ErrorNotice({ error, title }: { error: unknown; title?: string }) {
  const description = describeError(error);
  const showDetails = import.meta.env.DEV && description.code !== undefined;
  return (
    <StatusNotice status="error" title={title ?? description.title}>
      <p>{description.message}</p>
      {showDetails && (
        <p className="mt-2 font-mono text-xs break-all">
          {description.code}
          {description.details !== undefined && ` ${JSON.stringify(description.details)}`}
        </p>
      )}
    </StatusNotice>
  );
}
