import type { IssueWorkMode } from "@paperclipai/shared";
import { Check, ClipboardList, MessageCircleQuestion, Paperclip, Plus, Target, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { workModeMetaFor } from "@/lib/work-mode-meta";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ComposerAddMenuProps {
  mode: IssueWorkMode;
  onModeChange?: (mode: IssueWorkMode) => void;
  onAttachFile?: () => void;
  attachDisabled?: boolean;
  onGoal?: () => void;
  disabled?: boolean;
  triggerTestId?: string;
  menuTestId?: string;
}

export function ComposerAddMenu({
  mode, onModeChange, onAttachFile, attachDisabled, onGoal, disabled, triggerTestId, menuTestId,
}: ComposerAddMenuProps) {
  if (!onModeChange && !onAttachFile && !onGoal) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label="Add to composer" aria-keyshortcuts={onModeChange ? "Meta+Period Control+Period Shift+Tab" : undefined}
        disabled={disabled} data-testid={triggerTestId}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        <Plus className="size-4" aria-hidden />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" sideOffset={8} data-testid={menuTestId}
      className="w-(--sz-300px) rounded-xl p-1.5 shadow-sm">
      <div className="px-2 py-1 text-xs text-muted-foreground">Add</div>
      {onAttachFile ? <DropdownMenuItem onSelect={onAttachFile} disabled={attachDisabled} data-testid="composer-add-file">
        <Paperclip className="size-4" aria-hidden />
        <span className="flex-1">Files and images</span>
      </DropdownMenuItem> : null}
      {onGoal ? <DropdownMenuItem onSelect={onGoal} data-testid="composer-add-goal">
        <Target className="size-4" aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-2"><span>Goal</span><span className="truncate text-xs text-muted-foreground">Keep pursuing</span></span>
      </DropdownMenuItem> : null}
      {onModeChange ? <>
        <DropdownMenuItem onSelect={() => onModeChange(mode === "planning" ? "standard" : "planning")} data-testid="composer-add-plan">
          <ClipboardList className="size-4" aria-hidden />
          <span className="flex min-w-0 flex-1 items-baseline gap-2"><span>Plan mode</span><span className="truncate text-xs text-muted-foreground">Plan before acting</span></span>
          {mode === "planning" ? <Check className="size-4" aria-hidden /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onModeChange(mode === "ask" ? "standard" : "ask")} data-testid="composer-add-ask">
          <MessageCircleQuestion className="size-4" aria-hidden />
          <span className="flex min-w-0 flex-1 items-baseline gap-2"><span>Ask mode</span><span className="truncate text-xs text-muted-foreground">Answer without changes</span></span>
          {mode === "ask" ? <Check className="size-4" aria-hidden /> : null}
        </DropdownMenuItem>
      </> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}

interface ComposerModeChipProps {
  mode: IssueWorkMode;
  onRemove?: () => void;
  disabled?: boolean;
  testId?: string;
}

export function ComposerModeChip({ mode, onRemove, disabled, testId }: ComposerModeChipProps) {
  if (mode === "standard") return null;
  const meta = workModeMetaFor(mode);
  const Icon = meta.icon;
  return <button type="button" onClick={onRemove} disabled={disabled || !onRemove}
    aria-label={`Remove ${meta.label}`} data-pending-work-mode={mode} data-testid={testId}
    className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", meta.classes.chip)}>
    <Icon className="size-3.5" aria-hidden />
    <span>{meta.label}</span>
    <X className="size-3.5" aria-hidden />
  </button>;
}
