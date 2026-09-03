import { describe, expect, it, vi } from 'vitest';

// Render smoke tests for Sona UI integrations: every registry component we
// adopted must mount without crashing (SSR string + real DOM).

vi.mock('motion/react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('motion/react')>();
  return mod;
});

describe('sona component SSR', () => {
  it('renders all adopted primitives to string', async () => {
    const { renderToString } = await import('react-dom/server');
    const { default: FluidTabs } = await import('./components/ui/fluid-tabs/fluid-tabs');
    const { default: AnimatedSwitch } = await import('./components/ui/animated-switch/animated-switch');
    const { Button } = await import('./components/ui/button');
    const { default: ExpandingAction } = await import('./components/ui/expanding-action/expanding-action');
    const { default: HoldToDeleteButton } = await import('./components/ui/hold-to-delete-button/hold-to-delete-button');
    const { AccordionRoot, AccordionItem, AccordionItemTrigger, AccordionItemHeader, AccordionItemContent } = await import('./components/ui/accordion/accordion');
    const { default: SpotlightCard } = await import('./components/ui/spotlight-card/spotlight-card');
    const { SwitchRow, Tip, FluidTooltipGroup } = await import('./lib/ui');

    expect(renderToString(<FluidTabs value="a" onValueChange={() => {}} tabs={[{ value: 'a', title: 'A' }]} />)).toContain('A');
    expect(renderToString(<AnimatedSwitch checked onCheckedChange={() => {}} aria-label="x" />)).toContain('role="switch"');
    expect(renderToString(<Button className="btn filled">Save</Button>)).toContain('Save');
    expect(renderToString(<ExpandingAction trigger="Actions" items={[{ value: 'v', label: 'View' }]} onValueSelect={() => {}} />)).toContain('Actions');
    expect(renderToString(<HoldToDeleteButton label="Hold to delete" onDelete={() => {}} />)).toContain('Hold to delete');
    expect(renderToString(
      <AccordionRoot><AccordionItem value="1"><AccordionItemTrigger><AccordionItemHeader>Head</AccordionItemHeader></AccordionItemTrigger><AccordionItemContent>Body</AccordionItemContent></AccordionItem></AccordionRoot>,
    )).toContain('Head');
    expect(renderToString(<SpotlightCard className="stat-card">x</SpotlightCard>)).toContain('stat-card');
    expect(renderToString(<SwitchRow label="Enabled" checked onChange={() => {}} />)).toContain('Enabled');
    expect(renderToString(
      <FluidTooltipGroup><Tip id="t1" label="tip"><button type="button">b</button></Tip></FluidTooltipGroup>,
    )).toContain('tip');
  });
});

// Modal mounts its card into the document (Base UI portal) — every dialog
// in the app flows through it, so a mount failure would blank all dialogs.
// @vitest-environment happy-dom
describe('Modal DOM mount', () => {
  it('renders .dlg-card content in document', async () => {
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const { Modal } = await import('./lib/ui');
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(<Modal title="Hello" onClose={() => {}}><p>dialog-body</p></Modal>);
    });
    expect(document.body.innerHTML).toContain('dlg-card');
    expect(document.body.innerHTML).toContain('dialog-body');
    // Let enter animations settle before unmount so motion doesn't abort
    // in-flight animations (happy-dom reports those aborts as unhandled).
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    root.unmount();
    el.remove();
  });
});
