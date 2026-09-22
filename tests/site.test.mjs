import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${resolve('index.html')}`;
let nextPort = 9381;

async function waitForJson(url, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function withPage(viewport, fn) {
  const port = nextPort++;
  const profile = mkdtempSync(join(tmpdir(), 'arin-chrome-'));
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    pageUrl,
  ], { stdio: 'ignore' });

  try {
    const pages = await waitForJson(`http://127.0.0.1:${port}/json`);
    const target = pages.find(p => p.type === 'page');
    assert.ok(target?.webSocketDebuggerUrl, 'page target should exist');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });

    const call = (method, params = {}) => new Promise((resolveCall, reject) => {
      const callId = ++id;
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`CDP timeout: ${method}`));
      }, 5000);
      pending.set(callId, msg => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolveCall(msg.result);
      });
      ws.send(JSON.stringify({ id: callId, method, params }));
    });

    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    await call('Runtime.enable');
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const ready = await evaluate(`document.readyState`);
      if (ready === 'complete') break;
      await new Promise(r => setTimeout(r, 100));
    }
    await call('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    await new Promise(r => setTimeout(r, 250));
    await fn({ evaluate, call });
    ws.close();
  } finally {
    child.kill('SIGKILL');
    try { await once(child, 'exit'); } catch {}
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
}

function visibleLanguageCount(lang) {
  return `Array.from(document.querySelectorAll('[data-${lang}]')).filter(el => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden').length`;
}

test('language switch shows only the selected language', async () => {
  await withPage({ width: 390, height: 844 }, async ({ evaluate }) => {
    assert.equal(await evaluate(`document.documentElement.lang`), 'tr');
    assert.equal(await evaluate(visibleLanguageCount('ku')), 0);

    await evaluate(`document.getElementById('btn-ku').click()`);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(await evaluate(`document.documentElement.lang`), 'ku');
    assert.equal(await evaluate(visibleLanguageCount('tr')), 0);
    assert.equal(await evaluate(`document.getElementById('btn-ku').getAttribute('aria-pressed')`), 'true');

    const layout = await evaluate(`(() => ({
      strong: getComputedStyle(document.querySelector('.contact-card strong[data-ku]')).display,
      small: getComputedStyle(document.querySelector('.contact-card small[data-ku]')).display,
      valueTitle: getComputedStyle(document.querySelector('.value strong[data-ku]')).display,
      valueSub: getComputedStyle(document.querySelector('.value span[data-ku]')).display,
    }))()`);
    assert.equal(layout.strong, 'block', `KU strong must stay block: ${JSON.stringify(layout)}`);
    assert.equal(layout.small, 'block', `KU small must stay block: ${JSON.stringify(layout)}`);
    assert.equal(layout.valueTitle, 'block');
    assert.equal(layout.valueSub, 'block');
  });
});

test('mobile layout has no horizontal overflow', async () => {
  for (const width of [320, 390]) {
    await withPage({ width, height: 844 }, async ({ evaluate }) => {
      const metrics = await evaluate(`({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})`);
      assert.ok(metrics.scrollWidth <= metrics.clientWidth, `${width}px viewport overflows: ${JSON.stringify(metrics)}`);
    });
  }
});

test('desktop hero feels full-width while content stays readable', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate }) => {
    const layout = await evaluate(`(() => {
      const hero = document.querySelector('.hero');
      const heroGrid = document.querySelector('.hero-grid');
      const heroRect = hero.getBoundingClientRect();
      const gridRect = heroGrid.getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        heroWidth: heroRect.width,
        heroLeft: heroRect.left,
        gridWidth: gridRect.width,
      };
    })()`);

    assert.ok(layout.heroWidth >= layout.viewport * 0.96, `hero is still boxed: ${JSON.stringify(layout)}`);
    assert.ok(layout.heroLeft <= layout.viewport * 0.02, `hero starts too far from viewport edge: ${JSON.stringify(layout)}`);
    assert.ok(layout.gridWidth <= 1240, `hero content is too wide to read comfortably: ${JSON.stringify(layout)}`);
  });
});

test('mini-site contains the core visitor journey', async () => {
  await withPage({ width: 390, height: 844 }, async ({ evaluate }) => {
    const missing = await evaluate(`['about','activities','flow','join','faq','contact'].filter(id => !document.getElementById(id))`);
    assert.deepEqual(missing, []);
    assert.equal(await evaluate(`document.querySelectorAll('.flow-step').length`), 3);
    assert.ok((await evaluate(`document.querySelectorAll('a[href*="instagram.com/arinkultursanat"]').length`)) >= 1);
    assert.ok((await evaluate(`document.querySelectorAll('a[href^="mailto:arinogrencidernegi@gmail.com"]').length`)) >= 1);
    assert.ok((await evaluate(`document.querySelectorAll('.faq-item[open]').length`)) === 0);
    await evaluate(`document.querySelector('.faq-item summary').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.faq-item[open]').length`), 1);
  });
});

test('scroll reveal shows content and jumpbar tracks the section', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate }) => {
    assert.equal(await evaluate(`document.documentElement.classList.contains('anim-ready')`), true);

    await evaluate(`window.scrollTo({top: document.getElementById('contact').offsetTop, behavior: 'instant'})`);
    await new Promise(r => setTimeout(r, 1200));
    const card = await evaluate(`(() => {
      const el = document.querySelector('.contact-card');
      return { opacity: getComputedStyle(el).opacity, hasReveal: el.hasAttribute('data-reveal') };
    })()`);
    assert.equal(card.opacity, '1', `revealed card should be opaque: ${JSON.stringify(card)}`);
    assert.equal(card.hasReveal, false, 'reveal attribute should be cleaned up after animation');

    await evaluate(`window.scrollTo({top: document.getElementById('activities').offsetTop, behavior: 'instant'})`);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(await evaluate(`document.querySelector('.jumpbar a.active')?.getAttribute('href')`), '#activities');
    assert.equal(await evaluate(`document.querySelector('.jumpbar a.active')?.getAttribute('aria-current')`), 'true');
    assert.equal(await evaluate(`document.querySelectorAll('.jumpbar a[aria-current]').length`), 1);
  });
});

test('display font is wired for headings with a safe fallback', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate }) => {
    assert.ok((await evaluate(`document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]').length`)) >= 1);
    const fonts = await evaluate(`(() => ({
      h1: getComputedStyle(document.querySelector('.hero h1')).fontFamily,
      h2: getComputedStyle(document.querySelector('.section h2')).fontFamily,
    }))()`);
    assert.match(fonts.h1, /Fraunces/);
    assert.match(fonts.h1, /Georgia/);
    assert.match(fonts.h2, /Fraunces/);
  });
});

test('seo metadata and JSON-LD organization are present and valid', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate }) => {
    const meta = await evaluate(`(() => ({
      ogImage: document.querySelector('meta[property="og:image"]')?.content,
      twitterCard: document.querySelector('meta[name="twitter:card"]')?.content,
      jsonLd: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
    }))()`);
    assert.equal(meta.ogImage, 'https://arinogrencidernegi.github.io/logo-512.png');
    assert.equal(await evaluate(`document.querySelector('meta[property="og:url"]')?.content`), 'https://arinogrencidernegi.github.io/');
    assert.equal(meta.twitterCard, 'summary_large_image');
    assert.equal(meta.jsonLd['@type'], 'NGO');
    assert.equal(meta.jsonLd.email, 'arinogrencidernegi@gmail.com');
    assert.equal(meta.jsonLd.address.addressLocality, 'Fatih');
    assert.ok(meta.jsonLd.sameAs.includes('https://instagram.com/arinkultursanat'));

    const faq = await evaluate(`(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const s = scripts.map(el => { try { return JSON.parse(el.textContent); } catch (_) { return null; } })
        .find(o => o && o['@type'] === 'FAQPage');
      return s ? { count: s.mainEntity.length, first: s.mainEntity[0].name } : null;
    })()`);
    assert.ok(faq, 'FAQPage JSON-LD should exist');
    assert.equal(faq.count, 4);
    assert.equal(faq.first, "Arîn'e katılmak için ne yapmalıyım?");

    assert.equal(await evaluate(`document.querySelector('meta[name="color-scheme"]')?.content`), 'light dark');
  });
});

test('theme toggle switches palette and persists the choice', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate }) => {
    const initial = await evaluate(`document.documentElement.getAttribute('data-theme')`);
    assert.ok(initial === 'dark' || initial === 'light');

    const before = await evaluate(`getComputedStyle(document.body).backgroundColor`);
    await evaluate(`document.getElementById('btn-theme').click()`);
    const toggled = await evaluate(`document.documentElement.getAttribute('data-theme')`);
    assert.notEqual(toggled, initial);
    const after = await evaluate(`getComputedStyle(document.body).backgroundColor`);
    assert.notEqual(after, before, `palette should change on toggle: ${before} -> ${after}`);

    const stored = await evaluate(`localStorage.getItem('arin-theme')`);
    assert.equal(stored, toggled);
  });
});

test('perf and touch polish are wired', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate }) => {
    assert.ok((await evaluate(`document.querySelectorAll('img[fetchpriority="high"][decoding="async"]').length`)) >= 1);
    const css = await evaluate(`Array.from(document.styleSheets).map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\\n'); } catch (_) { return ''; } }).join('\\n')`);
    assert.match(css, /pointer:\s*coarse/);
    assert.match(css, /--hero-shadow/);
    assert.match(css, /min-height:\s*44px/);
  });
});

test('print media hides chrome and forces revealed content visible', async () => {
  await withPage({ width: 1440, height: 1000 }, async ({ evaluate, call }) => {
    await call('Emulation.setEmulatedMedia', { media: 'print' });
    const styles = await evaluate(`(() => ({
      jumpbar: getComputedStyle(document.querySelector('.jumpbar')).display,
      tools: getComputedStyle(document.querySelector('.hero-tools')).display,
      reveal: getComputedStyle(document.querySelector('[data-reveal]')).opacity,
      heroBg: getComputedStyle(document.querySelector('.hero')).backgroundColor,
    }))()`);
    assert.equal(styles.jumpbar, 'none');
    assert.equal(styles.tools, 'none');
    assert.equal(styles.reveal, '1');
    assert.equal(styles.heroBg, 'rgb(255, 255, 255)');
    await call('Emulation.setEmulatedMedia', { media: '' });

    assert.equal(await evaluate(`document.querySelectorAll('.jumpbar a').length`), 5);
    assert.ok((await evaluate(`document.querySelector('.jumpbar a[href="#faq"]') !== null`)), 'jumpbar should link to faq');

    await evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
    assert.equal(await evaluate(`document.querySelectorAll('.faq-item[open]').length`), 4);
    await evaluate(`window.dispatchEvent(new Event('afterprint'))`);
    assert.equal(await evaluate(`document.querySelectorAll('.faq-item[open]').length`), 0);
  });
});
