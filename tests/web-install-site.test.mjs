import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/* 14I.S4 — Install website.
   Reads the static web/site sources and asserts on their content: the site must
   be self-contained (no external or CDN assets, works over file://), carry the
   real working install commands for every shell, and wire the interactions
   (tabs, clipboard copy, scroll reveal, typing demo) defensively. No dist build
   is required; this only needs node:fs/url imports. */

test('14I.S4 install site: static, dependency-free landing page with real install commands', async () => {
  const [html, css, js] = await Promise.all([
    readFile(new URL('../web/site/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/site/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../web/site/app.js', import.meta.url), 'utf8'),
  ])

  /* Files exist and are substantial. */
  assert.ok(html.length > 4000, 'index.html exists and is substantial')
  assert.ok(css.length > 4000, 'styles.css exists and is substantial')
  assert.ok(js.length > 1500, 'app.js exists and is substantial')

  /* No external or CDN assets: the only script is ./app.js, the only link is ./styles.css. */
  const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(match => match[1])
  const linkHrefs = [...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(scriptSrcs, ['./app.js'])
  assert.deepEqual(linkHrefs, ['./styles.css'])
  assert.doesNotMatch(html, /<(img|source|video|audio|iframe|embed|object)\b/i, 'no external or binary asset tags')
  const useHrefs = [...html.matchAll(/<use[^>]*href="([^"]+)"/g)].map(match => match[1])
  assert.ok(useHrefs.length >= 8, 'icons are referenced from the inline sprite')
  assert.ok(useHrefs.every(href => href.startsWith('#')), 'sprite references are same-document fragments')
  assert.doesNotMatch(css, /url\(|@import|https?:\/\//i, 'CSS loads no external fonts or assets')
  assert.doesNotMatch(js, /https?:\/\//i, 'app.js references no external URLs')

  /* The universal install command appears verbatim, in the markup and in the demo. */
  assert.match(html, /npm install -g @whoops-1\/termagent/)
  assert.match(js, /npm install -g @whoops-1\/termagent/, 'the typing demo cycles the real install command')
  assert.match(html, /data-copy="npm install -g @whoops-1\/termagent"/)
  assert.ok((html.match(/data-copy="npm install -g @whoops-1\/termagent"/g) || []).length >= 3,
    'cmd, PowerShell and npm tabs all offer the real install command')

  /* All four shell tabs and their panels are present. */
  assert.match(html, /id="tab-cmd"/)
  assert.match(html, /id="tab-powershell"/)
  assert.match(html, /id="tab-npm"/)
  assert.match(html, /id="tab-source"/)
  assert.match(html, /id="panel-cmd"/)
  assert.match(html, /id="panel-powershell"/)
  assert.match(html, /id="panel-npm"/)
  assert.match(html, /id="panel-source"/)
  assert.match(html, /role="tablist"/)
  assert.match(html, /role="tabpanel"/)

  /* The cmd tab notes the Node >= 22 requirement with a node --version check line. */
  assert.match(html, /data-copy="node --version"/)
  assert.match(html, /Node\.js ≥ 22/)

  /* Source-build tab carries the full real sequence. */
  assert.match(html, /data-copy="git clone https:\/\/github\.com\/whoops-1\/termagent"/)
  assert.match(html, /data-copy="cd termagent"/)
  assert.match(html, /data-copy="npm install"/)
  assert.match(html, /data-copy="npm run build"/)
  assert.match(html, /data-copy="npm link"/)
  assert.ok((html.match(/data-copy="termagent"/g) || []).length >= 3, 'every npm-based tab ends with the termagent run command')

  /* Copy buttons are wired to the clipboard with a visible fallback path. */
  assert.ok((html.match(/class="copy"/g) || []).length >= 12, 'each command row has a copy button')
  assert.match(js, /navigator\.clipboard/)
  assert.match(js, /writeText/)
  assert.match(js, /execCommand\('copy'\)/, 'a manual-selection fallback exists for restricted contexts')
  assert.match(js, /copyStatus/, 'copy feedback is announced to assistive tech')

  /* Interactions: tabs, reveal, typing demo. */
  assert.match(js, /IntersectionObserver/)
  assert.match(js, /prefers-reduced-motion: reduce/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(css, /\.reveal/)
  assert.match(css, /\.visible/)
  assert.match(css, /\.t-caret/)
  assert.match(css, /@keyframes\s+caret-blink/)
  assert.match(css, /@keyframes\s+hero-pan/)
  assert.match(css, /@keyframes\s+float/)
  assert.match(css, /aria-selected/)
  assert.match(js, /aria-selected/)
  assert.match(js, /t-caret/, 'the typing demo drives the animated caret')

  /* index.html wires the stylesheet and the script. */
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css" \/>/)
  assert.match(html, /<script src="\.\/app\.js" defer><\/script>/)

  /* Package facts surfaced on the page. */
  assert.match(html, /1\.18\.0/)
  assert.match(html, /MIT/)
  assert.match(html, /@whoops-1\/termagent/)

  /* Feature coverage: six inline-SVG cards, three steps. */
  assert.equal((html.match(/class="card reveal"/g) || []).length, 6)
  for (const icon of ['i-terminal', 'i-phone', 'i-monitor', 'i-plug', 'i-layers', 'i-package']) {
    assert.match(html, new RegExp(`href="#${icon}"`), `feature icon ${icon} is inline SVG from the sprite`)
  }
  assert.equal((html.match(/class="step reveal"/g) || []).length, 3)

  /* Reduced motion must not leave reveal content hidden even if JS runs. */
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /js \.reveal \{ opacity: 1/)
})
