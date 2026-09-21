import chalk from 'chalk';
import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { resolveApiKey } from './config.js';
import { AttioApiError, AttioAuthError, AttioRateLimitError } from './errors.js';

const BASE_URL = 'https://api.attio.com/v2';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const asSeconds = Number(retryAfter);
    if (!Number.isNaN(asSeconds)) {
      return Math.max(0, Math.ceil(asSeconds * 1000));
    }

    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }

  return INITIAL_BACKOFF_MS * Math.pow(2, attempt);
}

export class AttioClient {
  private apiKey: string;
  private debug: boolean;

  constructor(apiKey?: string, debug?: boolean) {
    this.apiKey = resolveApiKey(apiKey);
    this.debug = debug ?? false;
  }

  private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? MAX_RETRIES;

    if (this.debug) {
      console.error(chalk.dim(`→ ${method} ${url}`));
      if (body !== undefined) {
        console.error(chalk.dim(`  body: ${JSON.stringify(body)}`));
      }
    }

    if (!this.apiKey) {
      throw new AttioAuthError('No API key configured');
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch (err: any) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') {
          throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${method} ${path}`);
        }
        throw err;
      }
      if (this.debug) {
        console.error(chalk.dim(`← ${response.status} ${response.statusText}`));
      }

      if (response.status === 429) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          const backoff = Math.max(100, getRetryDelayMs(response, attempt));
          if (this.debug) {
            console.error(chalk.dim(`  retrying in ${backoff}ms`));
          }
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw new AttioRateLimitError(`Rate limited after ${maxRetries} retries`);
      }

      if (response.status === 401) {
        clearTimeout(timer);
        throw new AttioAuthError('Invalid or expired API key');
      }

      if (response.status === 204) {
        clearTimeout(timer);
        return undefined as T;
      }

      let json: any;
      try {
        json = await response.json();
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${method} ${path}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (this.debug && !response.ok) {
        console.error(chalk.dim(`  error: ${JSON.stringify(json)}`));
      }

      if (!response.ok) {
        const errorType = json?.type ?? 'unknown_error';
        let errorDetail = json?.message ?? json?.detail ?? response.statusText;
        if (json?.validation_errors?.length) {
          const details = json.validation_errors.map((e: any) =>
            `${e.path?.join('.') || '?'}: ${e.message}`
          ).join('; ');
          errorDetail += ` [${details}]`;
        }
        throw new AttioApiError(response.status, errorType, errorDetail);
      }

      return json as T;
    }

    // Should not reach here, but just in case
    throw new AttioRateLimitError(`Rate limited after ${maxRetries} retries`);
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  /** Stream a file without forwarding the API key to the signed download URL. */
  async downloadFile(fileId: string, destination: string): Promise<{ sha256: string; bytes: number }> {
    if (!this.apiKey) throw new AttioAuthError('No API key configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        response = await fetch(`${BASE_URL}/files/${encodeURIComponent(fileId)}/download`, {
          headers: { Authorization: `Bearer ${this.apiKey}` }, redirect: 'manual', signal: controller.signal,
        });
        if (response.status !== 429) break;
        await response.body?.cancel();
        if (attempt === MAX_RETRIES) throw new AttioRateLimitError('File download rate limited');
        await new Promise(resolve => setTimeout(resolve, Math.max(100, getRetryDelayMs(response!, attempt))));
      }
      if (!response) throw new Error('Missing file download response');
      if (response.status === 401) { await response.body?.cancel(); throw new AttioAuthError('Invalid or expired API key'); }
      if (response.status >= 400) {
        const body: any = await response.json().catch(() => ({}));
        throw new AttioApiError(response.status, body.type ?? 'download_error', body.message ?? 'File download unavailable');
      }
      // Redirects are followed manually. Signed URLs and their query strings never enter logs or checkpoints.
      for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
        if (hop >= 5) { await response.body?.cancel(); throw new Error('Too many file download redirects'); }
        const location: string | null = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('File download redirect has no location');
        const url: URL = new URL(location, response.url || BASE_URL);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe file download redirect');
        response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`File download returned HTTP ${response.status}`);
      }
      file = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          hash.update(chunk.value); bytes += chunk.value.byteLength;
          await file.writeFile(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const length = response.headers.get('content-length');
      if (length !== null && !response.headers.get('content-encoding') && Number(length) !== bytes) {
        throw new Error('File download length mismatch');
      }
      await file.sync();
      return { sha256: hash.digest('hex'), bytes };
    } catch (error) {
      if (file) { await file.close(); file = undefined; await unlink(destination).catch(() => undefined); }
      throw error;
    } finally {
      if (file) await file.close();
      clearTimeout(timer);
    }
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
