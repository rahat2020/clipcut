"use client";

import { Popover } from "@base-ui/react/popover";
import { ListChecksIcon } from "lucide-react";

import { StageList, type StageView } from "@/components/app/stage-list";
import { buttonVariants } from "@/components/ui/button";
import type { StageName } from "@/shared/enums";

/**
 * A finished video's processing steps, one click away in the header — they no longer take
 * room in the side panel once the clips are what matters.
 */
export function StepsPopover({ stages }: { stages: Partial<Record<StageName, StageView | null>> }) {
  return (
    <Popover.Root>
      <Popover.Trigger className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <ListChecksIcon />
        Steps
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="w-80 rounded-xl border bg-card p-4 shadow-xl outline-none">
            <Popover.Title className="mb-3 text-sm font-medium">Processing steps</Popover.Title>
            <StageList stages={stages} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
