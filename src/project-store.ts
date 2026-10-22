import { openDB, type IDBPDatabase } from 'idb';
import type { CodeProject, ThemeMode } from './types';

interface CodexaDB {
  projects: CodeProject;
  settings: { key: string; value: unknown };
}

let databasePromise: Promise<IDBPDatabase<CodexaDB>> | undefined;

function database() {
  databasePromise ??= openDB<CodexaDB>('codexa-studio', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    },
  });
  return databasePromise;
}

export async function getProjects(): Promise<CodeProject[]> {
  return (await database()).getAll('projects');
}

export async function saveProject(project: CodeProject): Promise<void> {
  await (await database()).put('projects', { ...project, updatedAt: Date.now() });
}

export async function removeProject(id: string): Promise<void> {
  await (await database()).delete('projects', id);
}

export async function getTheme(): Promise<ThemeMode> {
  const record = await (await database()).get('settings', 'theme');
  return record?.value === 'light' ? 'light' : 'dark';
}

export async function saveTheme(theme: ThemeMode): Promise<void> {
  await (await database()).put('settings', { key: 'theme', value: theme });
}
