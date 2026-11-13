/* TermAgent install site — static, dependency-free interactions.
   Install-command tabs, copy-to-clipboard buttons, IntersectionObserver
   scroll reveals, and the demo terminal typing loop. Plain script, no build. */

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* Gates the .reveal hidden state in CSS, so content stays visible without JS. */
document.documentElement.classList.add('js')

/* ---------- Install command tabs ---------- */
function initTabs() {
  const tablist = $('[role="tablist"]')
  if (!tablist) return
  const tabs = $$('[role="tab"]', tablist)
  const panels = $$('.tabpanel')
  if (!tabs.length || !panels.length) return
  const select = (tab, setFocus = false) => {
    for (const item of tabs) {
      const on = item === tab
      item.setAttribute('aria-selected', String(on))
      item.tabIndex = on ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute('aria-controls')
    if (setFocus) tab.focus()
  }
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]')
    if (tab && tabs.includes(tab)) select(tab)
  })
  tablist.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const current = tabs.indexOf(document.activeElement)
    if (current < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    select(tabs[next], true)
  })
  const wanted = tabs.find((tab) => `#${tab.dataset.tab}` === location.hash)
  select(wanted || tabs[0])
}

/* ---------- Copy buttons ---------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  try {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    const ok = document.execCommand('copy')
    field.remove()
    return ok
  } catch {}
  return false
}

function initCopy() {
  const status = $('#copyStatus')
  for (const button of $$('.copy[data-copy]')) {
    button.addEventListener('click', async () => {
      const text = button.dataset.copy
      if (!text) return
      const ok = await copyText(text)
      const label = $('.copy-label', button)
      if (!ok) {
        if (status) status.textContent = 'Copy failed. Select the command text and copy it manually.'
        return
      }
      button.classList.add('is-copied')
      if (label) label.textContent = 'Copied'
      button.setAttribute('aria-label', `Copied: ${text}`)
      if (status) status.textContent = 'Command copied to clipboard.'
      clearTimeout(button.copyTimer)
      button.copyTimer = setTimeout(() => {
        button.classList.remove('is-copied')
        if (label) label.textContent = 'Copy'
        button.setAttribute('aria-label', `Copy: ${text}`)
      }, 1800)
    })
  }
}

/* ---------- Scroll reveals ---------- */
function initReveal() {
  const items = $$('.reveal')
  if (!items.length) return
  const showAll = () => items.forEach((item) => item.classList.add('visible'))
  if (reducedMotion.matches || !('IntersectionObserver' in window)) { showAll(); return }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('visible')
      observer.unobserve(entry.target)
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 })
  items.forEach((item) => observer.observe(item))
  if (typeof reducedMotion.addEventListener === 'function') {
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) { observer.disconnect(); showAll() }
    })
  }
}

/* ---------- Demo terminal typing loop ---------- */
const DEMO_SCRIPT = [
  { kind: 'type', text: 'npm install -g @whoops-1/termagent' },
  { kind: 'out', lines: [
    { text: '+ @whoops-1/termagent@1.18.0', tone: 'ok' },
    { text: 'added 1 package in 4s' },
  ] },
  { kind: 'type', text: 'termagent' },
  { kind: 'out', lines: [
    { text: 'TermAgent 1.18.0 — ready' },
    { text: 'describe a change or run /help', tone: 'hi' },
  ] },
  { kind: 'pause', ms: 3400 },
]

function demoLine(body, { prompt = false, tone = '', caret = false }) {
  const row = document.createElement('div')
  row.className = `t-line${tone ? ` t-out${tone === 'ok' ? ' t-ok' : tone === 'hi' ? ' t-hi' : ''}` : ''}`
  if (prompt) {
    const mark = document.createElement('span')
    mark.className = 't-prompt'
    mark.textContent = '~ $ '
    row.appendChild(mark)
  }
  const text = document.createElement('span')
  text.className = 't-text'
  text.textContent = ''
  row.appendChild(text)
  if (caret) {
    const mark = document.createElement('span')
    mark.className = 't-caret'
    row.appendChild(mark)
  }
  body.appendChild(row)
  return text
}

function renderStaticDemo(body) {
  body.textContent = ''
  for (const step of DEMO_SCRIPT) {
    if (step.kind === 'type') demoLine(body, { prompt: true }).textContent = step.text
    if (step.kind === 'out') for (const line of step.lines) demoLine(body, { tone: line.tone }).textContent = line.text
  }
  demoLine(body, { prompt: true, caret: true })
}

async function waitVisible() {
  while (document.hidden) await sleep(400)
}

async function playOnce(body) {
  body.textContent = ''
  for (const step of DEMO_SCRIPT) {
    await waitVisible()
    if (reducedMotion.matches) return
    if (step.kind === 'type') {
      $$('.t-caret', body).forEach((mark) => mark.remove())
      const text = demoLine(body, { prompt: true, caret: true })
      for (const char of step.text) {
        text.textContent += char
        await sleep(26 + Math.random() * 42)
        if (reducedMotion.matches) return
      }
      await sleep(430)
    } else if (step.kind === 'out') {
      for (const line of step.lines) {
        demoLine(body, { tone: line.tone }).textContent = line.text
        await sleep(280)
      }
    } else if (step.kind === 'pause') {
      await sleep(step.ms)
    }
  }
}

async function runDemo(body) {
  while (!reducedMotion.matches && body.isConnected) await playOnce(body)
  if (reducedMotion.matches && body.isConnected) renderStaticDemo(body)
}

function initTerminalDemo() {
  const body = $('#demoBody')
  if (!body) return
  if (reducedMotion.matches) { renderStaticDemo(body); return }
  runDemo(body)
  if (typeof reducedMotion.addEventListener === 'function') {
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) renderStaticDemo(body)
    })
  }
}

/* ---------- Boot: every enhancement fails soft ---------- */
function safe(init) {
  try { init() } catch { /* the page stays fully readable without JS enhancements */ }
}
safe(initTabs)
safe(initCopy)
safe(initReveal)
safe(initTerminalDemo)

