import { Injectable, Logger } from '@nestjs/common';
import type { LinkPreviewDTO } from '@signalix/contracts';

const URL_REGEX =
  /https?:\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/[^\s<>"{}|\\^`[\]]*)?/g;

const FETCH_TIMEOUT_MS = 3_000;
const MAX_BODY_BYTES = 500_000;

// Block localhost, link-local, and all RFC-1918 ranges
const UNSAFE_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /\.local$/i,
];

// User-Agent that major sites (GitHub, Reddit, etc.) respond to normally
const SCRAPER_UA =
  'Mozilla/5.0 (compatible; Signalix/1.0; +https://signalix.app/bot)';

/* ─── oEmbed providers ───────────────────────────────────────────────────── */

interface OEmbedProvider {
  pattern: RegExp;
  endpoint: (url: string) => string;
}

interface OEmbedResponse {
  title?: string;
  description?: string;
  thumbnail_url?: string;
  author_name?: string;
}

const OEMBED_PROVIDERS: OEmbedProvider[] = [
  {
    // youtube.com/watch and youtu.be short links
    pattern: /^https?:\/\/(?:www\.)?youtube\.com\/|^https?:\/\/youtu\.be\//i,
    endpoint: (url) =>
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  },
  {
    pattern: /^https?:\/\/(?:www\.)?vimeo\.com\//i,
    endpoint: (url) =>
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
  },
];

/* ─── Service ────────────────────────────────────────────────────────────── */

@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);

  extractFirstUrl(text: string): string | null {
    URL_REGEX.lastIndex = 0;
    const match = URL_REGEX.exec(text);
    if (!match) return null;
    // Strip trailing punctuation that's likely not part of the URL
    return match[0].replace(/[.,;:!?)>\]]+$/, '');
  }

  isUnsafeUrl(urlStr: string): boolean {
    try {
      const { protocol, hostname } = new URL(urlStr);
      if (protocol !== 'http:' && protocol !== 'https:') return true;
      return UNSAFE_PATTERNS.some((p) => p.test(hostname));
    } catch {
      return true;
    }
  }

  async fetchPreview(rawUrl: string): Promise<LinkPreviewDTO | null> {
    if (this.isUnsafeUrl(rawUrl)) return null;

    let urlObj: URL;
    try {
      urlObj = new URL(rawUrl);
    } catch {
      return null;
    }

    const domain = urlObj.hostname.replace(/^www\./, '');

    // Single shared timeout budget for all attempts
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      // 1. oEmbed — reliable structured data for known providers
      const provider = OEMBED_PROVIDERS.find((p) => p.pattern.test(rawUrl));
      if (provider) {
        try {
          const data = await this.callOEmbed(provider.endpoint(rawUrl), controller.signal);
          if (data?.title) {
            const imageUrl = this.resolveImage(data.thumbnail_url, rawUrl);
            return {
              url: rawUrl,
              domain,
              title: data.title,
              ...(data.description && { description: data.description }),
              ...(imageUrl && { imageUrl }),
            };
          }
        } catch (err) {
          if (controller.signal.aborted) return null;
          this.logger.debug(`oEmbed failed for ${rawUrl}: ${(err as Error).message}`);
        }
      }

      if (controller.signal.aborted) return null;

      // 2. HTML scraping for all other URLs (and as fallback for oEmbed providers)
      try {
        return await this.scrapeHtml(rawUrl, domain, controller.signal);
      } catch (err) {
        this.logger.debug(`HTML scrape failed for ${rawUrl}: ${(err as Error).message}`);
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async callOEmbed(
    endpointUrl: string,
    signal: AbortSignal,
  ): Promise<OEmbedResponse | null> {
    const res = await fetch(endpointUrl, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as OEmbedResponse;
  }

  private async scrapeHtml(
    rawUrl: string,
    domain: string,
    signal: AbortSignal,
  ): Promise<LinkPreviewDTO | null> { // null when no useful metadata found
    const res = await fetch(rawUrl, {
      signal,
      headers: {
        'User-Agent': SCRAPER_UA,
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return null; // not HTML — no preview to show
    }

    // Stream body up to MAX_BODY_BYTES then cancel
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (!reader) return { url: rawUrl, domain };

    try {
      while (total < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const html = Buffer.concat(chunks).toString('utf-8');
    return this.parseMetadata(rawUrl, domain, html);
  }

  private parseMetadata(url: string, domain: string, html: string): LinkPreviewDTO | null {
    const meta = extractAllMetaTags(html);

    const title =
      meta.get('og:title') ??
      meta.get('twitter:title') ??
      meta.get('title') ??
      extractPageTitle(html);

    const description =
      meta.get('og:description') ??
      meta.get('twitter:description') ??
      meta.get('description');

    const rawImage = meta.get('og:image') ?? meta.get('twitter:image');
    const imageUrl = this.resolveImage(rawImage, url);

    // Require at least a title to consider the preview worthwhile
    if (!title && !description && !imageUrl) return null;

    return {
      url,
      domain,
      ...(title && { title }),
      ...(description && { description }),
      ...(imageUrl && { imageUrl }),
    };
  }

  private resolveImage(rawImage: string | undefined, baseUrl: string): string | undefined {
    if (!rawImage) return undefined;
    try {
      const resolved = new URL(rawImage, baseUrl).toString();
      return this.isUnsafeUrl(resolved) ? undefined : resolved;
    } catch {
      return undefined;
    }
  }
}

/* ─── HTML helpers ───────────────────────────────────────────────────────── */

/**
 * Parses all <meta> tags from HTML, returning a map of name/property → content.
 * Handles tags with attributes in any order and across multiple lines.
 */
function extractAllMetaTags(html: string): Map<string, string> {
  const result = new Map<string, string>();

  // Search only within <head> for efficiency; fall back to first 60 KB
  const headMatch = /<head[\s\S]*?<\/head>/i.exec(html);
  const target = headMatch ? headMatch[0] : html.slice(0, 60_000);

  // Match the attribute block of each <meta> tag
  // [^>]* matches any character except > (includes newlines in JS regex)
  const TAG_RE = /<meta\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = TAG_RE.exec(target)) !== null) {
    const attrs = tagMatch[1];

    // Extract name= or property= value (either quote style)
    const keyMatch = /\b(?:property|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    // Extract content= value
    const valMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);

    if (keyMatch && valMatch) {
      const key = (keyMatch[1] ?? keyMatch[2] ?? '').toLowerCase().trim();
      const val = valMatch[1] ?? valMatch[2] ?? '';
      if (key && val) result.set(key, decode(val.trim()));
    }
  }

  return result;
}

function extractPageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1] ? decode(m[1].trim()) : null;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}
