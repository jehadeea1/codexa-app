import type { CodeProject } from './types';

export function setFileLanguage(project: CodeProject, path: string, language: string | null): CodeProject {
  const file = project.files[path];
  if (!file) return project;
  const files = { ...project.files, [path]: { ...file, languageOverride: language, updatedAt: Date.now() } };
  return { ...project, files, updatedAt: Date.now() };
}
