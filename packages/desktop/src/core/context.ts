import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, now } from './store';
import { hash, files, readSource } from './repository';

type Cached = { id: string; content: string; createdAt: string; sources: Record<string, string> };
export class ContextBroker {
  constructor(readonly store: Store) {}
  async search(root: string, query: string, limit = 40) {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((x) => x.length > 2)
      .slice(0, 12);
    const result: { path: string; line: number; text: string }[] = [];
    for (const path of await files(root)) {
      if (/lock|\.svg$|\.map$/.test(path)) continue;
      try {
        const content = await readSource(root, path);
        for (const [index, line] of content.split('\n').entries()) {
          if (terms.some((term) => line.toLowerCase().includes(term)))
            result.push({ path, line: index + 1, text: line.slice(0, 240) });
          if (result.length >= limit) return result;
        }
      } catch {
        /* Binaries and large files stay available through targeted tools. */
      }
    }
    return result;
  }
  async package(root: string, query: string) {
    const inventory = await files(root);
    const context: string[] = [];
    for (const path of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
      try {
        const text = await readSource(root, path);
        context.push(
          `${path}\n${text.slice(0, 8000)}${text.length > 8000 ? '\n[Excerpt. Read more if needed.]' : ''}`,
        );
      } catch {}
    }
    const snippets = await this.search(root, query);
    return `Repository inventory (first 150 paths):\n${inventory.slice(0, 150).join('\n')}\n\nProject instructions and references:\n${context.join('\n\n')}\n\nSearch evidence:\n${snippets.map((r) => `${r.path}:${r.line} ${r.text}`).join('\n')}`;
  }
  async cacheKey(
    root: string,
    paths: string[],
    question: string,
    model: string,
    version = 'bulk-reader-v1',
  ) {
    const sources: Record<string, string> = {};
    for (const path of [...paths].sort()) sources[path] = hash(await readSource(root, path));
    const instructions: Record<string, string> = {};
    const pathsToHash = new Set([
      'AGENTS.md',
      'CLAUDE.md',
      ...(await files(root)).filter((path) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path)),
    ]);
    for (const path of pathsToHash) {
      try {
        instructions[path] = hash(await readSource(root, path));
      } catch {
        instructions[path] = 'missing';
      }
    }
    return {
      key: hash(JSON.stringify({ root, sources, instructions, question, model, version })),
      sources,
    };
  }
  cached(key: string) {
    return this.store.get<Cached>('cache', key)?.content;
  }
  cache(key: string, content: string, sources: Record<string, string>) {
    this.store.put('cache', key, { id: key, content, sources, createdAt: now() });
  }
}
