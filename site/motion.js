const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
const demos = globalThis.document.querySelectorAll('[data-demo]');

function syncMotionPreference() {
  for (const demo of demos) {
    demo.querySelector('[data-replay]').hidden = reducedMotion.matches;
    if (reducedMotion.matches) demo.classList.remove('is-playing');
  }
}

for (const demo of demos) {
  demo.querySelector('[data-replay]').addEventListener('click', () => {
    demo.classList.remove('is-playing');
    void demo.offsetWidth;
    demo.classList.add('is-playing');
  });
}

const terminal = globalThis.document.querySelector('.terminal');
if ('IntersectionObserver' in globalThis) {
  const observer = new globalThis.IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    if (!reducedMotion.matches) terminal.classList.add('is-playing');
    observer.disconnect();
  }, { threshold: 0.35 });
  observer.observe(terminal);
} else if (!reducedMotion.matches) {
  terminal.classList.add('is-playing');
}

reducedMotion.addEventListener('change', syncMotionPreference);
syncMotionPreference();
