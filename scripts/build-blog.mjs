#!/usr/bin/env node
/**
 * DriveVault blog index builder
 * -----------------------------
 * Scans /blog/*.html, reads the metadata already inside each article,
 * and regenerates /blog.html (and /feed.xml) from scripts/blog.template.html.
 *
 * Run locally:  node scripts/build-blog.mjs
 * In CI:        see .github/workflows/build-blog.yml
 *
 * No dependencies. Node 18+.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(ROOT, 'blog');
const TEMPLATE = join(ROOT, 'scripts', 'blog.template.html');
const OUT_HTML = join(ROOT, 'blog.html');
const OUT_FEED = join(ROOT, 'feed.xml');

const SITE = 'https://www.drivevault.io';
const SITE_NAME = 'DriveVault';
const FEED_LIMIT = 20;

/* Files in /blog that are not articles. */
const IGNORE = new Set(['index.html', 'template.html', '_template.html']);

/* Tag -> colour palette. Add new tags here; anything unlisted falls back to
   'slate', which still looks intentional. Keys are matched case-insensitively. */
const TAG_COLORS = {
  'gear guide': 'gold',
  'gear & workflow': 'gold',
  'ssd review': 'gold',
  'review': 'gold',
  'workflow & tools': 'gold',
  'how-to': 'blue',
  'how to': 'blue',
  'tutorial': 'blue',
  'team workflow': 'blue',
  'updates': 'green',
  'changelog': 'green',
  'tips': 'purple',
  'archive guide': 'purple',
  'breaking news': 'red',
  'storage market': 'red',
  'news': 'red',
};

/* ------------------------------------------------------------------ */
/* Tiny HTML helpers                                                    */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  bull: '\u2022', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
};

function decode(str = '') {
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripTags(html = '') {
  return decode(html.replace(/<[^>]*>/g, ' '));
}

/* Parse every <meta> tag into a lookup keyed by name AND property. */
function readMeta(html) {
  const out = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-z0-9:_-]+)\s*=\s*"([^"]*)"|([a-z0-9:_-]+)\s*=\s*'([^']*)'/gi)) {
      attrs[(m[1] || m[3]).toLowerCase()] = m[2] ?? m[4] ?? '';
    }
    const key = attrs.name || attrs.property || attrs.itemprop;
    if (key && attrs.content !== undefined) out[key.toLowerCase()] = decode(attrs.content);
  }
  return out;
}

/* Pull the Article / BlogPosting node out of any JSON-LD blocks. */
function readJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
    for (const node of nodes) {
      const type = String(node?.['@type'] || '');
      if (/Article|BlogPosting|NewsArticle/i.test(type)) return node;
    }
  }
  return null;
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ */
/* Article parsing                                                      */
/* ------------------------------------------------------------------ */

function toISODate(value, fallbackFile) {
  if (value) {
    const iso = String(value).trim();
    // Already ISO-ish
    const direct = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
    if (direct) return direct[1];
    const parsed = new Date(iso);
    if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  }
  if (fallbackFile) return statSync(fallbackFile).mtime.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function prettyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function parseArticle(file) {
  const path = join(BLOG_DIR, file);
  const html = readFileSync(path, 'utf8');
  const meta = readMeta(html);
  const ld = readJsonLd(html) || {};
  const warn = [];

  if (meta['dv:draft'] === 'true' || meta['dv:hidden'] === 'true') return null;

  /* Headline */
  const title =
    meta['dv:title'] ||
    meta['og:title'] ||
    ld.headline ||
    stripTags(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i)) ||
    decode(firstMatch(html, /<title>([\s\S]*?)<\/title>/i)).replace(/\s*[|\u2013-]\s*DriveVault\s*$/i, '');

  /* Excerpt shown on the card */
  const excerpt =
    meta['dv:excerpt'] ||
    meta['description'] ||
    meta['og:description'] ||
    ld.description ||
    '';

  /* Cover image */
  const image =
    meta['dv:image'] ||
    meta['og:image'] ||
    firstMatch(html, /class="cover-image"[\s\S]{0,400}?<img[^>]+src="([^"]+)"/i) ||
    firstMatch(html, /<img[^>]+src="([^"]+)"/i);

  /* Alt text for the card image */
  const alt =
    meta['dv:image-alt'] ||
    decode(firstMatch(html, /class="cover-image"[\s\S]{0,400}?<img[^>]+alt="([^"]*)"/i)) ||
    title;

  /* Tag / category */
  const tag =
    meta['dv:tag'] ||
    stripTags(firstMatch(html, /<span[^>]*class="[^"]*\beyebrow\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)) ||
    ld.articleSection ||
    'Article';

  /* Date */
  const date = toISODate(meta['dv:date'] || ld.datePublished || meta['article:published_time'], path);
  const updated = toISODate(ld.dateModified || meta['article:modified_time'] || date, null);

  if (!meta['dv:date'] && !ld.datePublished && !meta['article:published_time']) {
    warn.push('no publish date found (used file modified time) — add <meta name="dv:date" content="YYYY-MM-DD">');
  }
  if (!image) warn.push('no cover image found — add <meta property="og:image" content="...">');
  if (!excerpt) warn.push('no excerpt found — add <meta name="description" content="...">');

  return {
    file,
    url: `/blog/${file}`,
    absUrl: `${SITE}/blog/${file}`,
    title,
    excerpt,
    image,
    alt,
    tag,
    color: TAG_COLORS[tag.toLowerCase()] || 'slate',
    date,
    updated,
    dateLabel: prettyDate(date),
    featured: meta['dv:featured'] === 'true',
    warn,
  };
}

/* ------------------------------------------------------------------ */
/* Card rendering                                                       */
/* ------------------------------------------------------------------ */

const ARROW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';

function renderFeatured(p) {
  return `      <article class="featured-card">
        <div class="featured-image">
          <img src="${esc(p.image)}" alt="${esc(p.alt)}" loading="eager" decoding="async">
          <span class="featured-badge">New</span>
        </div>
        <div class="featured-content">
          <div class="featured-meta">
            <time class="featured-date" datetime="${p.date}">${p.dateLabel}</time>
            <span class="tag tag-${p.color}">${esc(p.tag)}</span>
          </div>
          <h2><a href="${esc(p.url)}">${esc(p.title)}</a></h2>
          <p class="featured-excerpt">${esc(p.excerpt)}</p>
          <a class="featured-link" href="${esc(p.url)}">Read the full article ${ARROW}</a>
        </div>
      </article>`;
}

function renderCard(p) {
  return `        <article class="post-card">
          <div class="post-card-image">
            <img src="${esc(p.image)}" alt="${esc(p.alt)}" loading="lazy" decoding="async">
          </div>
          <div class="post-card-content">
            <div class="post-card-meta">
              <time class="post-card-date" datetime="${p.date}">${p.dateLabel}</time>
              <span class="tag tag-${p.color}">${esc(p.tag)}</span>
            </div>
            <h3 class="post-card-title"><a href="${esc(p.url)}">${esc(p.title)}</a></h3>
            <p class="post-card-excerpt">${esc(p.excerpt)}</p>
            <a class="post-card-link" href="${esc(p.url)}">Read post ${ARROW}</a>
          </div>
        </article>`;
}

function renderFeed(posts) {
  const items = posts.slice(0, FEED_LIMIT).map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${esc(p.absUrl)}</link>
      <guid isPermaLink="true">${esc(p.absUrl)}</guid>
      <category>${esc(p.tag)}</category>
      <pubDate>${new Date(`${p.date}T09:00:00Z`).toUTCString()}</pubDate>
      <description>${esc(p.excerpt)}</description>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME} Blog</title>
    <link>${SITE}/blog.html</link>
    <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Honest SSD reviews, gear guides and tips for managing external drives on macOS.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function renderItemListLd(posts) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${SITE_NAME} Blog`,
    url: `${SITE}/blog.html`,
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: `${SITE}/favicon.png` },
    },
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: p.absUrl,
      datePublished: p.date,
      dateModified: p.updated,
      image: p.image,
      description: p.excerpt,
      author: { '@type': 'Organization', name: SITE_NAME },
    })),
  }, null, 2);
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const files = readdirSync(BLOG_DIR)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .filter((f) => !IGNORE.has(f.toLowerCase()) && !f.startsWith('_') && !f.startsWith('.'));

  if (!files.length) {
    console.error('No articles found in /blog — nothing to build.');
    process.exit(1);
  }

  const posts = files.map(parseArticle).filter(Boolean);

  for (const p of posts) {
    for (const w of p.warn) console.warn(`  warning  ${p.file}: ${w}`);
  }

  /* Newest first. A post with dv:featured="true" is pinned to the top. */
  posts.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.file.localeCompare(b.file);
  });

  const [featured, ...rest] = posts;

  const template = readFileSync(TEMPLATE, 'utf8');
  const html = template
    .replace('<!--FEATURED-->', renderFeatured(featured))
    .replace('<!--POSTS-->', rest.map(renderCard).join('\n'))
    .replace(/<!--POST_COUNT-->/g, String(posts.length))
    .replace(/<!--BUILD_DATE-->/g, new Date().toISOString())
    .replace('<!--BLOG_LD-->', renderItemListLd(posts));

  writeFileSync(OUT_HTML, html);
  writeFileSync(OUT_FEED, renderFeed(posts));

  console.log(`Built blog.html with ${posts.length} post${posts.length === 1 ? '' : 's'}.`);
  console.log(`  featured: ${featured.title} (${featured.dateLabel})`);
  for (const p of rest) console.log(`  - ${p.dateLabel.padEnd(13)} [${p.tag}] ${p.title}`);
}

main();
