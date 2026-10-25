const doc = globalThis.document;
const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)');

// Output is trimmed from real CLI runs; the static markup in #term is the no-JS and reduced-motion fallback.
const steps = [
  { scene: 0, stage: 0, cmd: 'continuity init', out: ['project_id: prj_d241df15', 'name: relay-engine'] },
  { scene: 0, stage: 1, cmd: 'continuity sync', out: ['files: 72', 'bytes: 418204'] },
  { scene: 0, stage: 2, cmd: 'continuity memory remember "Retries must be bounded to 5 attempts." --key retry-limit --source AGENTS.md', out: ['status: persist', 'reason: Exact excerpt from a current project source; source remains authoritative.', 'outcome: persisted'] },
  { scene: 0, stage: 3, cmd: 'continuity handoff create --file handoff.json', out: ['id: handoff_30cf526c', 'recommended_next_action: Add a regression test for the retry limit'] },
  { scene: 1, stage: 4, boot: [
    ['t-dim', 'Primary workspace · healthy · synced just now · 72 sources'],
    ['t-boot-head', 'Latest handoff'],
    ['', '  claude-code · in progress · just now'],
    ['', '  Implement bounded reconnect'],
    ['t-str', '  Next: Add a regression test for the retry limit'],
    ['t-boot-head', 'Durable memory'],
    ['', '  retry-limit · memory · source-backed (AGENTS.md)'],
    ['t-dim', '    Retries must be bounded to 5 attempts.']
  ] },
  { scene: 1, stage: 4, cmd: 'continuity context "bounded reconnect" --budget 1500', out: ['1384/1500 UTF-8 bytes · 2 items', 'rule · AGENTS.md'] }
];
const sceneTitles = ['# Session 01 · Claude Code', '# Session 02 · Codex'];

class Cancelled extends Error {}

function el(tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function initTerminal(root) {
  const term = root.querySelector('#term');
  const code = term.querySelector('code');
  const controls = root.querySelector('[data-controls]');
  const toggle = root.querySelector('[data-toggle]');
  const replay = root.querySelector('[data-replay]');
  const progress = root.querySelector('[data-progress]');
  const stageButtons = [...progress.querySelectorAll('[data-stage]')];
  const tabs = [...root.querySelectorAll('[data-tab]')];
  const rail = root.querySelector('[data-rail]');
  const railNodes = [...rail.querySelectorAll('[data-node]')];

  let token = 0;
  let userPaused = false;
  let hiddenPaused = false;
  let resumers = [];
  let instant = false;

  const isPaused = () => userPaused || hiddenPaused;

  function release() {
    if (isPaused()) return;
    for (const resume of resumers) resume();
    resumers = [];
  }

  async function wait(ms, run) {
    if (instant) return;
    let remaining = ms;
    while (remaining > 0) {
      if (run !== token) throw new Cancelled();
      if (isPaused()) await new Promise((resolve) => resumers.push(resolve));
      if (run !== token) throw new Cancelled();
      const slice = Math.min(remaining, 40);
      await new Promise((resolve) => globalThis.setTimeout(resolve, slice));
      remaining -= slice;
    }
  }

  function follow() { term.scrollTop = term.scrollHeight; }

  function line(...children) {
    const node = el('span', instant ? 't-line is-instant' : 't-line');
    node.append(...children);
    code.append(node);
    follow();
    return node;
  }

  function outputLine(text) {
    const match = /^([a-z_]+:)(.*)$/.exec(text);
    if (!match) return line(text);
    const value = match[1] === 'recommended_next_action:' ? el('span', 't-str', match[2]) : match[2];
    return line(el('span', 't-key', match[1]), value);
  }

  function setScene(scene) {
    tabs.forEach((tab, index) => tab.classList.toggle('is-active', index === scene));
    railNodes.forEach((node) => node.classList.toggle('is-active', node.dataset.node === String(scene)));
  }

  function setStage(stage, done) {
    stageButtons.forEach((button, index) => {
      button.classList.toggle('is-done', index < stage || (index === stage && done));
      button.classList.toggle('is-active', index === stage && !done);
      button.setAttribute('aria-current', index === stage ? 'step' : 'false');
    });
  }

  async function switchScene(scene, run) {
    line(el('span', 't-comment', '# session ended · handoff saved'));
    await wait(700, run);
    rail.classList.remove('is-transferring');
    void rail.offsetWidth;
    rail.classList.add('is-transferring');
    term.classList.add('is-switching');
    await wait(380, run);
    code.replaceChildren();
    term.classList.remove('is-switching');
    setScene(scene);
    await wait(700, run);
    rail.classList.remove('is-transferring');
  }

  async function playStep(step, run) {
    if (step.boot) {
      const box = el('span', instant ? 't-boot is-instant' : 't-boot');
      const title = el('span', 't-line t-boot-title', 'Continuity · relay-engine');
      title.append(el('span', 't-badge', 'SessionStart hook'));
      box.append(title);
      code.append(box);
      for (const [className, text] of step.boot) {
        await wait(70, run);
        const row = el('span', instant ? 't-line is-instant' : 't-line');
        row.append(className ? el('span', className, text || ' ') : (text || ' '));
        box.append(row);
        follow();
      }
      await wait(1100, run);
      return;
    }
    const cmd = el('span', 't-cmd', '');
    const cursor = el('span', 'cursor');
    line(el('span', 't-prompt', '$'), ' ', cmd, cursor);
    if (instant) cmd.textContent = step.cmd;
    else {
      for (const char of step.cmd) {
        cmd.textContent += char;
        if (char === ' ') follow();
        await wait(char === ' ' ? 55 : 14 + Math.random() * 28, run);
      }
      await wait(320, run);
    }
    cursor.remove();
    for (const text of step.out) {
      await wait(90, run);
      outputLine(text);
    }
    await wait(900, run);
  }

  async function play(fromStage) {
    const run = ++token;
    const start = steps.findIndex((step) => step.stage === fromStage);
    const scene = steps[start].scene;
    code.replaceChildren();
    term.scrollTop = 0;
    term.classList.remove('is-switching');
    rail.classList.remove('is-transferring');
    setStage(fromStage, false);
    setScene(scene);
    controls.classList.remove('is-finished');
    try {
      instant = true;
      line(el('span', 't-comment', sceneTitles[scene]));
      for (const step of steps.slice(0, start)) if (step.scene === scene) await playStep(step, run);
      instant = false;
      let current = scene;
      for (const step of steps.slice(start)) {
        if (step.scene !== current) {
          await switchScene(step.scene, run);
          current = step.scene;
          line(el('span', 't-comment', sceneTitles[current]));
          await wait(400, run);
        }
        setStage(step.stage, false);
        await playStep(step, run);
        setStage(step.stage, true);
      }
      line(el('span', 't-prompt', '$'), ' ', el('span', 'cursor'));
      controls.classList.add('is-finished');
      await wait(7000, run);
      play(0);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    }
  }

  function setUserPaused(value) {
    userPaused = value;
    toggle.classList.toggle('is-paused', value);
    toggle.setAttribute('aria-label', value ? 'Resume animation' : 'Pause animation');
    toggle.title = value ? 'Play' : 'Pause';
    root.classList.toggle('is-paused', value);
    release();
  }

  toggle.addEventListener('click', () => setUserPaused(!userPaused));
  replay.addEventListener('click', () => { setUserPaused(false); play(0); });
  stageButtons.forEach((button, index) => button.addEventListener('click', () => { setUserPaused(false); play(index); }));

  // Pause while the terminal is off screen or the tab is hidden.
  let offscreen = false;
  const syncHidden = () => { hiddenPaused = offscreen || doc.hidden; release(); };
  doc.addEventListener('visibilitychange', syncHidden);
  if ('IntersectionObserver' in globalThis) {
    new globalThis.IntersectionObserver(([entry]) => { offscreen = !entry.isIntersecting; syncHidden(); }).observe(term);
  }

  function start() {
    if (reducedMotion.matches) return;
    controls.hidden = false;
    progress.hidden = false;
    play(0);
  }
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { token++; controls.hidden = true; progress.hidden = true; }
    else start();
  });
  start();
}

function initReveal() {
  if (reducedMotion.matches || !('IntersectionObserver' in globalThis)) return;
  const targets = doc.querySelectorAll('.section h2, .section .lede, [data-reveal], .feature, .steps li, .callouts > div, .browser, .integration, .principles > div, .closing-inner');
  const observer = new globalThis.IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  for (const target of targets) {
    // Only hide what is still below the fold, so nothing visible ever flashes away.
    if (target.getBoundingClientRect().top < globalThis.innerHeight) continue;
    const siblings = [...target.parentElement.children].filter((node) => node.matches('.feature, .steps li, .callouts > div, .integration, .principles > div'));
    const index = siblings.indexOf(target);
    if (index > 0) target.style.setProperty('--delay', `${index * 70}ms`);
    target.classList.add('reveal');
    observer.observe(target);
  }
}

const terminal = doc.querySelector('[data-term]');
if (terminal) initTerminal(terminal);
initReveal();
