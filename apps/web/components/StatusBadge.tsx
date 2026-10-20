import type { EnvelopeStatus } from "@walkup/contracts";
import { STATUS_CLASS, STATUS_LABEL } from "@/lib/labels";

/** The status in words, in the secondary colour (bold when the operator should look). No pill, no dot. */
export function StatusBadge({ status, className = "" }: { status: EnvelopeStatus; className?: string }) {
  return (
    <span className={`text-sm ${STATUS_CLASS[status]} ${className}`}>
      <span className="sr-only">status: </span>
      {STATUS_LABEL[status]}
    </span>
  );
}
