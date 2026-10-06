"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/admin/action";

type Confirm = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Ask for text: a reason, or a typed confirmation that must equal `mustEqual`. */
  input?: { label: string; placeholder?: string; mustEqual?: string };
};

/**
 * One admin action behind a button: optional confirmation dialog (with a reason or a
 * typed confirmation), then the server action, a toast, and a refresh of the page data.
 * `action` is a server action, usually bound to the record id on the server.
 */
export function ActionButton({
  label,
  icon,
  variant = "outline",
  action,
  confirm,
  success,
  redirectTo,
}: {
  label: string;
  icon?: ReactNode;
  variant?: "default" | "outline" | "destructive" | "secondary";
  /** Gets the typed text ("" when the dialog asks for none). */
  action: (text: string) => Promise<ActionResult<unknown>>;
  confirm?: Confirm;
  success: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      const result = await action(confirm?.input ? text.trim() : "");
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(success);
      setOpen(false);
      setText("");
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    });

  if (!confirm) {
    return (
      <Button variant={variant} size="sm" onClick={run} disabled={pending}>
        {icon}
        {pending ? "Working…" : label}
      </Button>
    );
  }

  const inputOk = !confirm.input || (confirm.input.mustEqual ? text.trim().toLowerCase() === confirm.input.mustEqual.toLowerCase() : text.trim().length >= 3);
  return (
    <AlertDialog open={open} onOpenChange={(o) => (pending ? null : setOpen(o))}>
      <AlertDialogTrigger render={<Button variant={variant} size="sm" />}>
        {icon}
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {confirm.input && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="admin-action-input">{confirm.input.label}</Label>
            <Input
              id="admin-action-input"
              value={text}
              placeholder={confirm.input.placeholder}
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant={confirm.destructive ? "destructive" : "default"} onClick={run} disabled={pending || !inputOk}>
            {pending ? "Working…" : confirm.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
