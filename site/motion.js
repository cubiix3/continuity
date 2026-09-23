const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
const demos = globalThis.document.querySelectorAll('[data-demo]');
const flowSteps = globalThis.document.querySelectorAll('[data-flow-step]');
const flowPanels = globalThis.document.querySelectorAll('[data-flow-panel]');

function syncMotionPreference() {
  for (const demo of demos) {
    demo.querySelector('[data-replay]').hidden = reducedMotion.matches;
    if (reducedMotion.matches) demo.classList.remove('is-playing');
  }
  if (reducedMotion.matches) {
    for (const panel of flowPanels) panel.classList.remove('is-entering');
  }
}

for (const demo of demos) {
  demo.querySelector('[data-replay]').addEventListener('click', () => {
    demo.classList.remove('is-playing');
    void demo.offsetWidth;
    demo.classList.add('is-playing');
  });
}

for (const step of flowSteps) {
  step.disabled = false;
  step.addEventListener('click', () => {
    const selected = step.dataset.flowStep;
    for (const button of flowSteps) {
      const active = button === step;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const panel of flowPanels) {
      panel.classList.remove('is-entering');
      panel.hidden = panel.dataset.flowPanel !== selected;
    }
    if (!reducedMotion.matches) {
      const activePanel = globalThis.document.querySelector(`[data-flow-panel="${selected}"]`);
      void activePanel.offsetWidth;
      activePanel.classList.add('is-entering');
    }
  });
}

if ('IntersectionObserver' in globalThis) {
  const firstPanel = flowPanels[0];
  const observer = new globalThis.IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    if (!reducedMotion.matches) firstPanel.classList.add('is-entering');
    observer.disconnect();
  }, { threshold: 0.45 });
  observer.observe(firstPanel);
}

reducedMotion.addEventListener('change', syncMotionPreference);
syncMotionPreference();
