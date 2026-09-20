import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectClient, ProjectResolver } from '../../core/src/index.js';
import { SqliteStorage } from '../../storage-sqlite/src/index.js';
import { FileSources } from '../../source-files/src/index.js';

/** Trusted composition root for local hosts. Do not pass this host into agent tools. */
export function openContinuity(home = process.env.CONTINUITY_HOME ?? join(homedir(), '.continuity')) {
  const storage = new SqliteStorage(join(home, 'continuity.db'));
  const resolver = new ProjectResolver(storage);
  const source = new FileSources(() => storage.projects().map(p => p.root));
  return {
    init: (path: string, name?: string) => resolver.init(path, name),
    projects: () => storage.projects(),
    project: (path: string) => new ProjectClient(storage, source, resolver.resolve(path)),
    doctor: () => storage.diagnose(),
    close: () => storage.close(),
  };
}
