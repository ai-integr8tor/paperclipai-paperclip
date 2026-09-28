import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, ChevronRight, RotateCcw, Search, X, Zap } from "lucide-react";
import type { Agent, IssueAssigneeAdapterOverrides } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  composerCatalogProvider, composerEfforts, composerFastAvailable, DEFAULT_COMPOSER_RUN_SETTINGS,
  EFFORT_LABELS, readComposerRunSettings, supportsComposerModel,
  type ComposerRunSettings,
} from "./composer-run-settings";
import "./composer-run-settings.css";

interface Props {
  companyId: string;
  assigneeValue: string;
  currentAssigneeValue: string;
  options: InlineEntityOption[];
  agents: ReadonlyMap<string, Agent>;
  overrides?: IssueAssigneeAdapterOverrides | null;
  settings: ComposerRunSettings | null;
  onSettingsChange: (settings: ComposerRunSettings) => void;
  onAssigneeChange: (value: string) => void;
  disabled?: boolean;
  mobile?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Storybook can supply a fixed catalog; the app loads it for the selected harness. */
  modelOptionsOverride?: readonly AdapterModel[];
  renderAssigneeIdentity?: (value: string, label: string, placement: "trigger" | "option") => ReactNode;
}

function AnimatedBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div className="composer-run-settings-height" style={{ height: height ?? "auto" }}><div ref={ref}>{children}</div></div>;
}

export function ComposerRunSettingsPicker({
  companyId, assigneeValue, currentAssigneeValue, options, agents, overrides,
  settings, onSettingsChange, onAssigneeChange, disabled = false, mobile: mobileProp, triggerRef, modelOptionsOverride, renderAssigneeIdentity,
}: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"settings" | "agents" | "models">("settings");
  const [modelSearch, setModelSearch] = useState("");
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [highlightedAssignee, setHighlightedAssignee] = useState(0);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const mobile = mobileProp ?? narrow;
  const agentId = assigneeValue.startsWith("agent:") ? assigneeValue.slice(6) : "";
  const agent = agents.get(agentId);
  const modelSupported = supportsComposerModel(agent);
  const provider = composerCatalogProvider(agent);
  const { data: fetchedModels = [], isPending: modelsPending } = useQuery({
    queryKey: agent && modelSupported
      ? queryKeys.agents.adapterModels(companyId, agent.adapterType, agent.defaultEnvironmentId ?? null, provider)
      : ["agents", "composer-models", "none"],
    queryFn: () => agentsApi.adapterModels(companyId, agent!.adapterType, {
      environmentId: agent!.defaultEnvironmentId ?? null, provider,
    }),
    enabled: Boolean(agent && modelSupported && !modelOptionsOverride),
  });
  const models = modelOptionsOverride ?? fetchedModels;
  const base = assigneeValue === currentAssigneeValue
    ? readComposerRunSettings(overrides, agent?.adapterType)
    : DEFAULT_COMPOSER_RUN_SETTINGS;
  const selected = settings ?? base;
  const configuredModel = typeof agent?.adapterConfig.model === "string" ? agent.adapterConfig.model : "";
  const model = selected.model ?? configuredModel;
  const modelName = models.find((item) => item.id === model)?.label ?? model ?? "";
  const choices = composerEfforts(agent, model, models.map((item) => item.id));
  const effort = selected.effort && choices.includes(selected.effort) ? selected.effort : null;
  const effortIndex = effort ? choices.indexOf(effort) + 1 : 0;
  const effortLabel = effort ? EFFORT_LABELS[effort] ?? effort : "Default";
  const fastAvailable = composerFastAvailable(agent, model);
  const changed = Boolean(selected.model || selected.effort || selected.fast);
  const assigneeOptions = [{ id: "", label: "No assignee", searchText: "Unassigned" }, ...options.filter((item) => item.id !== "")];
  const filteredAgents = assigneeOptions.filter((item) =>
    `${item.label} ${item.searchText ?? ""}`.toLowerCase().includes(assigneeSearch.trim().toLowerCase()));
  const query = modelSearch.trim();
  const filteredModels = models.filter((item) =>
    `${item.label} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  const exactMatch = models.some((item) => item.id.toLowerCase() === query.toLowerCase());
  const needsProvider = agent && ["opencode_local", "pi_local", "kimi_local"].includes(agent.adapterType);
  const manualValid = query.length > 0 && !/\s/.test(query)
    && (!needsProvider || /^[^/]+\/.+[^/]$/.test(query))
    && (provider !== "openrouter" || /^openrouter\/[^/]+\/.+[^/]$/.test(query));

  useEffect(() => {
    setView("settings");
    setModelSearch("");
    setAssigneeSearch("");
  }, [agentId]);

  const chooseAssignee = (value: string) => {
    if (value !== assigneeValue) {
      onAssigneeChange(value);
      onSettingsChange(DEFAULT_COMPOSER_RUN_SETTINGS);
    }
    setView("settings");
    setAssigneeSearch("");
  };
  const chooseModel = (value: string | null) => {
    onSettingsChange({ model: value, effort: null, fast: false });
    setView("settings");
    setModelSearch("");
  };
  const reset = () => onSettingsChange(DEFAULT_COMPOSER_RUN_SETTINGS);
  const closeButton = mobile ? <DialogClose asChild><button type="button" aria-label="Close picker" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent"><X className="size-4" /></button></DialogClose> : null;
  const trigger = <button ref={triggerRef} type="button" disabled={disabled} aria-label="Select assignee, model and effort" data-testid="task-chat-composer-assignee"
    className="flex h-8 min-w-0 max-w-64 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
    {renderAssigneeIdentity?.(assigneeValue, agent?.name ?? "Unassigned", "trigger")}
    <span className="max-w-24 truncate">{assigneeOptions.find((item) => item.id === assigneeValue)?.label ?? "Unassigned"}</span>
    {modelSupported ? <><span className="text-muted-foreground" aria-hidden>·</span><span className="min-w-0 truncate text-muted-foreground">{modelName || "Harness default"}</span></> : null}
    {effort ? <span className="hidden shrink-0 text-muted-foreground sm:inline">{effortLabel}</span> : null}
    <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
  </button>;

  const body = view === "settings" ? <div className="p-3">
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Choose assignee" onClick={() => setView("agents")}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {renderAssigneeIdentity?.(assigneeValue, agent?.name ?? "Unassigned", "option") ?? <span className="grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground">{agent?.name.slice(0, 1) ?? "?"}</span>}
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent?.name ?? options.find((item) => item.id === assigneeValue)?.label ?? "Unassigned"}</span><span className="block truncate text-xs text-muted-foreground">{agent?.adapterType ?? "Choose an agent"}</span></span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {!choices.length && modelSupported ? <button type="button" aria-label="Reset to agent default" title="Reset to agent default" disabled={!changed} onClick={reset} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40"><RotateCcw className="size-4" /></button> : null}
      {closeButton}
    </div>
    {modelSupported ? <>
      <button type="button" aria-label="Choose exact model" onClick={() => setView("models")} className="mt-3 flex w-full items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Model</span><span className="block truncate text-sm font-medium">{modelName || "Harness default"}</span></span><ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {choices.length ? <div className="mt-3">
        <div className="flex items-center gap-2">
          {fastAvailable ? <button type="button" aria-label="Fast mode" aria-pressed={selected.fast} title="Fast mode" onClick={() => onSettingsChange({ ...selected, fast: !selected.fast })} className={cn("grid size-8 shrink-0 place-items-center rounded-md hover:bg-accent", selected.fast ? "composer-run-settings-accent bg-accent" : "text-muted-foreground")}><Zap className="size-4" /></button> : <span className="size-8 shrink-0" aria-hidden />}
          <label htmlFor="composer-run-effort" className="composer-run-settings-accent min-w-0 flex-1 text-center text-sm font-medium">{effortLabel}</label>
          <button type="button" aria-label="Reset to agent default" title="Reset to agent default" disabled={!changed} onClick={reset} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40"><RotateCcw className="size-4" /></button>
        </div>
        <input id="composer-run-effort" type="range" min={0} max={choices.length} step={1} value={effortIndex} aria-label={agent?.adapterType === "pi_local" ? "Thinking" : "Effort"} aria-valuetext={effortLabel}
          onChange={(event) => onSettingsChange({ ...selected, effort: Number(event.target.value) === 0 ? null : choices[Number(event.target.value) - 1] })}
          className="composer-run-effort-range mt-3 w-full" style={{ "--fill": `${effortIndex / choices.length * 100}%` } as CSSProperties} />
      </div> : null}
    </> : null}
  </div> : view === "agents" ? <div className="p-2">
    <div className="flex items-center gap-2 px-1 py-1.5"><button type="button" aria-label="Back to selection" onClick={() => setView("settings")} className="grid size-7 place-items-center rounded-md hover:bg-accent"><ArrowLeft className="size-4" /></button><span className="min-w-0 flex-1 text-xs font-semibold">Choose assignee</span>{closeButton}</div>
    <div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><input autoFocus type="search" aria-label="Search assignees" placeholder="Search assignees…" value={assigneeSearch} onChange={(event) => { setAssigneeSearch(event.target.value); setHighlightedAssignee(0); }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setHighlightedAssignee((current) => filteredAgents.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + filteredAgents.length) % filteredAgents.length : 0); }
      if (event.key === "Enter" && filteredAgents.length) { event.preventDefault(); chooseAssignee(filteredAgents[Math.min(highlightedAssignee, filteredAgents.length - 1)]!.id); }
    }} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" /></div>
    <div className="mt-2 max-h-60 overflow-y-auto" role="listbox" aria-label="Assignees">{filteredAgents.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={item.id === assigneeValue} onMouseEnter={() => setHighlightedAssignee(index)} onClick={() => chooseAssignee(item.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-none", highlightedAssignee === index ? "bg-accent" : "hover:bg-accent")}>{renderAssigneeIdentity?.(item.id, item.label, "option")}<span className="min-w-0 flex-1 truncate text-sm">{item.label}</span><span className="truncate text-xs text-muted-foreground">{agents.get(item.id.startsWith("agent:") ? item.id.slice(6) : "")?.adapterType ?? ""}</span>{item.id === assigneeValue ? <Check className="composer-run-settings-accent size-4" /> : null}</button>)}{!filteredAgents.length ? <p className="px-2 py-2 text-xs text-muted-foreground">No matches.</p> : null}</div>
  </div> : <div className="p-2">
    <div className="flex items-center gap-2 px-1 py-1.5"><button type="button" aria-label="Back to selection" onClick={() => setView("settings")} className="grid size-7 place-items-center rounded-md hover:bg-accent"><ArrowLeft className="size-4" /></button><span className="min-w-0 flex-1 text-xs font-semibold">Choose model · {agent?.adapterType}</span>{closeButton}</div>
    <div className="relative mt-2"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden /><input autoFocus type="search" aria-label="Search or paste a model ID" placeholder="Search or paste a model ID" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && manualValid && !exactMatch) chooseModel(query); }} className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" /></div>
    <div className="mt-2 max-h-60 overflow-y-auto" role="listbox" aria-label="Models">
      {!query ? <button type="button" role="option" aria-selected={selected.model === null} onClick={() => chooseModel(null)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent"><span className="min-w-0 flex-1">Use agent default</span>{selected.model === null ? <Check className="composer-run-settings-accent size-4" /> : null}</button> : null}
      {filteredModels.map((item) => <button type="button" role="option" aria-selected={selected.model === item.id} key={item.id} onClick={() => chooseModel(item.id)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.label}</span><span className="block truncate font-mono text-xs text-muted-foreground">{item.id}</span></span>{selected.model === item.id ? <Check className="composer-run-settings-accent size-4" /> : null}</button>)}
      {modelsPending && !modelOptionsOverride ? <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading models…</p> : null}
      {(!modelsPending || modelOptionsOverride) && !filteredModels.length && query ? <p className="px-2.5 py-2 text-xs text-muted-foreground">No catalog match.</p> : null}
    </div>
    {query && !exactMatch ? <button type="button" disabled={!manualValid} onClick={() => chooseModel(query)} className="mt-2 w-full truncate border-t border-border px-2.5 py-2 text-left text-sm hover:bg-accent disabled:opacity-40">Use exact ID <span className="font-mono font-semibold">{query}</span></button> : null}
  </div>;

  const onOpenChange = (next: boolean) => { setOpen(next); if (!next) { setView("settings"); setModelSearch(""); setAssigneeSearch(""); } };
  return mobile ? <Dialog open={open} onOpenChange={onOpenChange}><DialogTrigger asChild>{trigger}</DialogTrigger><DialogContent aria-describedby={undefined} showCloseButton={false} className="composer-run-settings-mobile top-(--pct-50) -translate-y-(--pct-50) gap-0 overflow-y-auto p-0"><DialogTitle className="sr-only">Select assignee, model and effort</DialogTitle><AnimatedBody>{body}</AnimatedBody></DialogContent></Dialog>
    : <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent side="top" align="end" sideOffset={8} className="w-80 max-w-full p-0 shadow-sm"><AnimatedBody>{body}</AnimatedBody></PopoverContent></Popover>;
}
