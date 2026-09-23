const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
const term = globalThis.document.getElementById('term');
const toggle = globalThis.document.getElementById('term-toggle');

// The static markup in #term is the no-JS and reduced-motion fallback; keep both in sync.
const steps = [
  { comment: '# Session 01 · Claude Code' },
  { cmd: 'continuity init', out: ['project_id: prj_d241df15', 'name: relay-engine'] },
  { cmd: 'continuity sync', out: ['files: 72'] },
  { cmd: 'continuity memory remember "Retries are bounded to 5 attempts." --key retry-limit --source AGENTS.md', out: ['status: persist', 'reason: Exact excerpt from a current project source; source remains authoritative.'] },
  { cmd: 'continuity handoff create --file handoff.json', out: ['id: handoff_30cf526c', 'recommended_next_action: Add a regression test for the retry limit'] },
  { comment: '', pause: 900 },
  { comment: '# Session 02 · Codex, same project' },
  { cmd: 'continuity handoff latest', out: ['from: {"agent":"claude-code","session":"session-7f3a"}', 'task: {"goal":"Implement bounded reconnect","status":"in_progress"}', 'risks: ["Unbounded retries can amplify an outage"]', 'recommended_next_action: Add a regression test for the retry limit'] }
];

let paused = false;
let resumers = [];
let running = false;

function span(className, text) {
  const node = globalThis.document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

async function wait(ms) {
  let remaining = ms;
  while (remaining > 0) {
    if (paused) await new Promise((resolve) => resumers.push(resolve));
    const step = Math.min(remaining, 50);
    await new Promise((resolve) => globalThis.setTimeout(resolve, step));
    remaining -= step;
  }
}

function follow() { term.scrollTop = term.scrollHeight; }

function outputLine(code, line) {
  const match = /^([a-z_]+:)(.*)$/.exec(line);
  if (!match) { code.append(line, '\n'); return; }
  code.append(span('t-key', match[1]));
  if (match[1] === 'recommended_next_action:') code.append(' ', span('t-str', match[2].trim()));
  else code.append(match[2]);
  code.append('\n');
}

async function play(code) {
  code.replaceChildren();
  term.scrollTop = 0;
  for (const step of steps) {
    if ('comment' in step) {
      if (step.comment) code.append(span('t-comment', step.comment));
      code.append('\n');
      follow();
      await wait(step.pause ?? 450);
      continue;
    }
    code.append(span('t-prompt', '$'), ' ');
    const cmd = span('t-cmd', '');
    const cursor = span('cursor', '');
    code.append(cmd, cursor);
    for (const char of step.cmd) {
      cmd.textContent += char;
      follow();
      await wait(char === ' ' ? 60 : 16 + Math.random() * 30);
    }
    await wait(380);
    cursor.remove();
    code.append('\n');
    for (const line of step.out) {
      await wait(110);
      outputLine(code, line);
      follow();
    }
    await wait(650);
  }
  code.append(span('t-prompt', '$'), ' ', span('cursor', ''));
  follow();
  await wait(5000);
}

async function loop() {
  if (running) return;
  running = true;
  const code = term.querySelector('code');
  while (!reducedMotion.matches) await play(code);
  running = false;
}

function setPaused(value) {
  paused = value;
  toggle.setAttribute('aria-label', paused ? 'Resume animation' : 'Pause animation');
  toggle.querySelector('[data-toggle-label]').textContent = paused ? 'Play' : 'Pause';
  if (!paused) { for (const resume of resumers) resume(); resumers = []; }
}

if (term && toggle) {
  toggle.addEventListener('click', () => setPaused(!paused));
  if (!reducedMotion.matches) {
    toggle.hidden = false;
    loop();
  }
  reducedMotion.addEventListener('change', () => {
    toggle.hidden = reducedMotion.matches;
    if (!reducedMotion.matches) { setPaused(false); loop(); }
  });
}
