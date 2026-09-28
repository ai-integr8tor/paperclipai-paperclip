import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ComposerRunSettingsLiveStory } from "../prototypes/composer-model-picker/ComposerRunSettingsLiveStory";

const openPicker = async (canvasElement: HTMLElement) => {
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(screen.getByRole("button", { name: "Select assignee, model and effort" }));
  return screen;
};

const meta = {
  title: "Tasks/Composer/Run settings (implemented)",
  component: ComposerRunSettingsLiveStory,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    docs: { description: { component: "The actual task composer control. Its assignee determines the harness and model catalog. Model IDs can be pasted; effort appears only when supported levels are known. Fast mode and reset are icons beside the effort name. The task composer saves these settings as task adapter overrides in the same request as the message." } },
  },
  args: { agentId: "codex", mobile: false },
} satisfies Meta<typeof ComposerRunSettingsLiveStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CodexEffort: Story = {
  name: "01 · Codex model and effort",
  args: { initialModel: "gpt-6-astra", initialEffort: "ultra", initialFast: true },
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await expect(screen.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "Ultra");
    await expect(screen.getByRole("button", { name: "Fast mode" })).toHaveAttribute("aria-pressed", "true");
  },
};

export const SearchAssignees: Story = {
  name: "02 · Search assignees",
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await userEvent.click(screen.getByRole("button", { name: "Choose assignee" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search assignees" }), "OpenRouter");
    await expect(screen.getByRole("option", { name: /Nora/ })).toBeVisible();
  },
};

export const SearchModel: Story = {
  name: "03 · Search exact models",
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await userEvent.click(screen.getByRole("button", { name: "Choose exact model" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search or paste a model ID" }), "Astra");
    await expect(screen.getByRole("option", { name: /GPT-6 Astra/ })).toBeVisible();
  },
};

export const OpenRouterCustomId: Story = {
  name: "04 · OpenRouter custom ID, unknown effort",
  args: { agentId: "openrouter", initialModel: "openrouter/qwen/qwen3-coder-next" },
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  },
};

export const ClaudeEffort: Story = {
  name: "05 · Claude effort",
  args: { agentId: "claude", initialEffort: "high" },
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await expect(screen.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "High");
    await expect(screen.queryByRole("button", { name: "Fast mode" })).not.toBeInTheDocument();
  },
};

export const NoModelHarness: Story = {
  name: "06 · Process agent",
  args: { agentId: "process" },
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await expect(screen.queryByRole("button", { name: "Choose exact model" })).not.toBeInTheDocument();
  },
};

export const MobileModal: Story = {
  name: "07 · Mobile modal",
  args: { mobile: true, initialModel: "gpt-6-astra" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => {
    const screen = await openPicker(canvasElement);
    await expect(screen.getByRole("dialog", { name: "Select assignee, model and effort" })).toBeVisible();
  },
};
